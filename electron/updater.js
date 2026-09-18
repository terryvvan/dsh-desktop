'use strict';

/**
 * DSH runtime manager + updater.
 *
 * The desktop app is two layers: a stable Electron shell, and the DSH runtime
 * it boots. Only the second layer turns over often, so instead of reinstalling
 * the whole application this installs new DSH versions into a private store
 * under the user data directory and atomically switches which one the shell
 * boots. The copy shipped inside the app stays untouched as an immutable
 * fallback, so a bad release always rolls back without reinstalling anything —
 * which is also why this works identically for the installed and the
 * no-install builds.
 *
 * Layout:
 *
 *   <userData>/runtime-state.json        channel, active version, failure count
 *   <userData>/runtimes/<version>/       an installed runtime tree
 *   <userData>/npm-cache/                the bundled npm's cache
 *
 * Both the version probe and the install are delegated to the bundled npm CLI
 * rather than reimplemented here. That is deliberate: npm already honours the
 * user's registry, proxy and TLS configuration, and on machines where the
 * public registry is unreachable that configuration is the only thing that
 * works.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DSH_PACKAGE = '@deepseek-ai/dsh';
/** Selectable update channels, mapped onto npm dist-tags. */
const CHANNELS = ['next', 'alpha', 'latest'];
const DEFAULT_CHANNEL = 'next';
/** Boot failures on an installed runtime before it is rolled back. */
const BOOT_FAILURE_LIMIT = 2;
const PROBE_TIMEOUT_MS = 60000;
const INSTALL_TIMEOUT_MS = 45 * 60 * 1000;

// ─── version comparison ──────────────────────────────────────────────────────
// Small SemVer subset: enough to order `0.1.5-rc.2` against `0.1.6-alpha.2`,
// which is exactly the comparison an update check needs.

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    String(value).trim(),
  );
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] === undefined ? [] : match[4].split('.'),
  };
}

function comparePrerelease(a, b) {
  if (a.length === 0 || b.length === 0) {
    if (a.length === b.length) return 0;
    // A release outranks any prerelease of the same core version.
    return a.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      if (Number(left) !== Number(right)) return Number(left) < Number(right) ? -1 : 1;
      continue;
    }
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) return 0;
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return comparePrerelease(left.pre, right.pre);
}

// ─── process helpers ─────────────────────────────────────────────────────────

/** Run a child to completion, capturing both streams. Never throws. */
function run(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: error.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: -1, stdout, stderr: `${stderr}\ntimed out after ${timeoutMs} ms` });
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => finish({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (code) => finish({ code, stdout, stderr }));
  });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function rmTree(target) {
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
}

// ─── manager ─────────────────────────────────────────────────────────────────

/**
 * @param {object} options
 * @param {string} options.bundledRuntimeDir  the immutable `resources/runtime`
 * @param {string} options.userDataDir        Electron's per-user data directory
 * @param {(message: string) => void} options.log
 */
function createRuntimeManager({ bundledRuntimeDir, userDataDir, log }) {
  const bundledAppDir = path.join(bundledRuntimeDir, 'app');
  const nodeExe = path.join(bundledRuntimeDir, 'node', 'node.exe');
  const npmCli = path.join(bundledRuntimeDir, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const runtimesDir = path.join(userDataDir, 'runtimes');
  const cacheDir = path.join(userDataDir, 'npm-cache');
  const stateFile = path.join(userDataDir, 'runtime-state.json');

  // ── state ──────────────────────────────────────────────────────────────────

  function readState() {
    const stored = readJson(stateFile) ?? {};
    return {
      channel: CHANNELS.includes(stored.channel) ? stored.channel : DEFAULT_CHANNEL,
      autoCheck: stored.autoCheck !== false,
      activeVersion: typeof stored.activeVersion === 'string' ? stored.activeVersion : null,
      previousVersion: typeof stored.previousVersion === 'string' ? stored.previousVersion : null,
      consecutiveBootFailures: Number.isFinite(stored.consecutiveBootFailures)
        ? stored.consecutiveBootFailures
        : 0,
      lastCheck: typeof stored.lastCheck === 'string' ? stored.lastCheck : null,
      skippedVersion: typeof stored.skippedVersion === 'string' ? stored.skippedVersion : null,
    };
  }

  function writeState(patch) {
    const next = { ...readState(), ...patch };
    fs.mkdirSync(userDataDir, { recursive: true });
    const temp = `${stateFile}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(temp, stateFile);
    return next;
  }

  // ── runtime trees ──────────────────────────────────────────────────────────

  function versionOf(root) {
    const manifest = readJson(path.join(root, 'node_modules', DSH_PACKAGE, 'package.json'));
    return typeof manifest?.version === 'string' ? manifest.version : null;
  }

  /** A tree is usable only if the shell's boot path and the Web assets exist. */
  function inspect(root) {
    const dshBin = path.join(root, 'node_modules', DSH_PACKAGE, 'lib', 'bin.js');
    const version = versionOf(root);
    if (version === null || !fs.existsSync(dshBin)) return null;

    const webApp = readJson(path.join(root, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'package.json'));
    const frontend = readJson(
      path.join(root, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'package.json'),
    );
    // The published family is versioned in lockstep; a mismatch means npm
    // resolved a mixed tree and the runtime must not be activated.
    if (webApp?.version !== version || frontend?.version !== version) return null;

    const frontendIndex = path.join(
      root,
      'node_modules',
      '@deepseek-ai',
      'dsh-web-frontend',
      'dist',
      'index.html',
    );
    if (!fs.existsSync(frontendIndex)) return null;

    return { root, version, dshBin, frontendIndex };
  }

  function bundled() {
    return inspect(bundledAppDir) ?? { root: bundledAppDir, version: null, dshBin: null };
  }

  function installedRoot(version) {
    return path.join(runtimesDir, version);
  }

  /**
   * Which runtime the shell should boot right now. Falls back to the bundled
   * copy whenever the recorded version is gone or no longer passes inspection.
   */
  function resolve() {
    const state = readState();
    if (state.activeVersion !== null) {
      const candidate = inspect(installedRoot(state.activeVersion));
      if (candidate !== null) return { ...candidate, source: 'installed' };
      log(`runtime ${state.activeVersion} is missing or invalid; falling back to the bundled copy`);
      writeState({ activeVersion: null });
    }
    const fallback = bundled();
    return { ...fallback, source: 'bundled' };
  }

  // ── update checks ──────────────────────────────────────────────────────────

  function npmEnv() {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('ELECTRON_')) delete env[key];
    }
    delete env.NODE_OPTIONS;
    // Keep the app self-contained: its own cache, no update banners, no audit.
    env.npm_config_cache = cacheDir;
    env.npm_config_update_notifier = 'false';
    env.npm_config_fund = 'false';
    env.npm_config_audit = 'false';
    return env;
  }

  function assertBundledNpm() {
    if (!fs.existsSync(npmCli)) {
      throw new Error(
        `bundled npm is missing at ${npmCli}; the runtime cannot be updated by this build`,
      );
    }
  }

  /** Read the channel's target version from the registry's dist-tags. */
  async function check({ channel } = {}) {
    assertBundledNpm();
    const state = readState();
    const useChannel = CHANNELS.includes(channel) ? channel : state.channel;
    const current = resolve().version;

    const result = await run(
      nodeExe,
      [npmCli, 'view', DSH_PACKAGE, 'dist-tags', '--json'],
      { env: npmEnv(), timeoutMs: PROBE_TIMEOUT_MS },
    );
    if (result.code !== 0) {
      const detail = result.stderr.trim().split(/\r?\n/).slice(0, 3).join(' ');
      throw new Error(detail === '' ? `npm exited with code ${result.code}` : detail);
    }

    let tags;
    try {
      tags = JSON.parse(result.stdout);
    } catch {
      throw new Error(`could not parse the registry response: ${result.stdout.slice(0, 200)}`);
    }

    const latest = typeof tags?.[useChannel] === 'string' ? tags[useChannel] : null;
    if (latest === null) throw new Error(`the registry publishes no "${useChannel}" tag`);

    const updateAvailable =
      current !== null && compareVersions(latest, current) > 0 && latest !== state.skippedVersion;

    const next = writeState({ channel: useChannel, lastCheck: new Date().toISOString() });
    return { channel: useChannel, current, latest, updateAvailable, tags, state: next };
  }

  // ── installation ───────────────────────────────────────────────────────────

  /** Remove leftover staging trees from an interrupted run. */
  function cleanStaging() {
    if (!fs.existsSync(runtimesDir)) return;
    for (const entry of fs.readdirSync(runtimesDir)) {
      if (entry.startsWith('.staging-')) rmTree(path.join(runtimesDir, entry));
    }
  }

  /**
   * Install `version` into the runtime store and switch to it.
   * Reuses an already-installed tree, so a rollback-then-reinstall is cheap.
   */
  async function install(version, { onProgress = () => {} } = {}) {
    assertBundledNpm();
    if (parseVersion(version) === null) throw new Error(`not a version: ${version}`);

    const target = installedRoot(version);
    const existing = inspect(target);
    if (existing !== null) {
      onProgress({ phase: 'activate', version });
      activate(version);
      return { version, root: target, reused: true };
    }

    fs.mkdirSync(runtimesDir, { recursive: true });
    cleanStaging();
    const staging = path.join(runtimesDir, `.staging-${version}-${process.pid}`);
    rmTree(staging);
    fs.mkdirSync(staging, { recursive: true });

    fs.writeFileSync(
      path.join(staging, 'package.json'),
      `${JSON.stringify(
        {
          name: 'dsh-desktop-runtime',
          private: true,
          version,
          dependencies: { [DSH_PACKAGE]: version },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    onProgress({ phase: 'download', version });
    log(`installing ${DSH_PACKAGE}@${version} into ${staging}`);
    const result = await run(
      nodeExe,
      [
        npmCli,
        'install',
        '--omit=dev',
        // Native dependencies ship prebuilt binaries inside their tarballs, so
        // no lifecycle scripts are needed — and skipping them keeps the install
        // independent of any build toolchain on the user's machine.
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--loglevel=error',
      ],
      { cwd: staging, env: npmEnv(), timeoutMs: INSTALL_TIMEOUT_MS },
    );

    if (result.code !== 0) {
      rmTree(staging);
      const detail = result.stderr.trim().split(/\r?\n/).slice(-4).join(' ');
      throw new Error(`npm install failed (${result.code}): ${detail}`);
    }

    onProgress({ phase: 'verify', version });
    const staged = inspect(staging);
    if (staged === null) {
      rmTree(staging);
      throw new Error(
        `the installed tree failed validation (missing entry point, Web assets, or mismatched family versions)`,
      );
    }

    onProgress({ phase: 'activate', version });
    rmTree(target);
    fs.renameSync(staging, target);
    activate(version);

    // Report the Node the interpreter will use, so an engines bump that needs a
    // newer Node is visible in the log rather than only as a later boot failure.
    const engines = readJson(path.join(target, 'node_modules', DSH_PACKAGE, 'package.json'))?.engines;
    if (engines?.node !== undefined) {
      log(`runtime ${version} declares engines.node=${engines.node}; bundled interpreter is ${process.version}`);
    }

    log(`activated runtime ${version}`);
    return { version, root: target, reused: false };
  }

  /** Point the shell at `version`, remembering what to fall back to. */
  function activate(version) {
    const state = readState();
    const previous = state.activeVersion === version ? state.previousVersion : state.activeVersion;
    return writeState({
      activeVersion: version,
      previousVersion: previous,
      consecutiveBootFailures: 0,
      skippedVersion: null,
    });
  }

  /** Drop back to the version active before the current one, else to bundled. */
  function rollback(reason) {
    const state = readState();
    const failed = state.activeVersion;
    const target = state.previousVersion;
    if (target !== null && inspect(installedRoot(target)) !== null) {
      log(`rolling back from ${failed} to ${target}: ${reason}`);
      writeState({
        activeVersion: target,
        previousVersion: null,
        consecutiveBootFailures: 0,
        skippedVersion: failed,
      });
      return { version: target, source: 'installed', reason };
    }
    log(`rolling back from ${failed} to the bundled runtime: ${reason}`);
    writeState({
      activeVersion: null,
      previousVersion: null,
      consecutiveBootFailures: 0,
      skippedVersion: failed,
    });
    return { version: bundled().version, source: 'bundled', reason };
  }

  function noteBootSuccess() {
    if (readState().consecutiveBootFailures !== 0) writeState({ consecutiveBootFailures: 0 });
  }

  /** @returns {{rolledBack: boolean, from?: string, to?: string, source?: string}} */
  function recordBootFailure(detail) {
    const state = readState();
    if (state.activeVersion === null) return { rolledBack: false };
    const failures = state.consecutiveBootFailures + 1;
    if (failures < BOOT_FAILURE_LIMIT) {
      writeState({ consecutiveBootFailures: failures });
      return { rolledBack: false, failures };
    }
    const from = state.activeVersion;
    const result = rollback(detail);
    return { rolledBack: true, from, to: result.version, source: result.source };
  }

  /** Keep the active and previous trees; drop everything else. */
  function prune() {
    if (!fs.existsSync(runtimesDir)) return [];
    const state = readState();
    const keep = new Set([state.activeVersion, state.previousVersion].filter((v) => v !== null));
    const removed = [];
    for (const entry of fs.readdirSync(runtimesDir)) {
      if (entry.startsWith('.staging-')) continue;
      if (keep.has(entry)) continue;
      rmTree(path.join(runtimesDir, entry));
      removed.push(entry);
    }
    if (removed.length > 0) log(`pruned runtimes: ${removed.join(', ')}`);
    return removed;
  }

  function describe() {
    const state = readState();
    const resolved = resolve();
    return {
      channel: state.channel,
      autoCheck: state.autoCheck,
      active: resolved.version,
      source: resolved.source,
      bundled: bundled().version,
      previous: state.previousVersion,
      lastCheck: state.lastCheck,
      consecutiveBootFailures: state.consecutiveBootFailures,
      installed: fs.existsSync(runtimesDir)
        ? fs
            .readdirSync(runtimesDir)
            .filter((entry) => !entry.startsWith('.staging-'))
            .sort(compareVersions)
        : [],
    };
  }

  return {
    CHANNELS,
    paths: { bundledRuntimeDir, bundledAppDir, nodeExe, npmCli, runtimesDir, cacheDir, stateFile },
    readState,
    writeState,
    resolve,
    check,
    install,
    activate,
    rollback,
    noteBootSuccess,
    recordBootFailure,
    prune,
    describe,
    cleanStaging,
  };
}

module.exports = { createRuntimeManager, compareVersions, CHANNELS, DEFAULT_CHANNEL, BOOT_FAILURE_LIMIT };
