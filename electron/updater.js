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
 *   <userData>/update-cache/tarballs/    tarballs fetched by the downloader
 *
 * Both the version probe and the install are delegated to the bundled npm CLI
 * rather than reimplemented here. That is deliberate: npm already honours the
 * user's registry, proxy and TLS configuration, and on machines where the
 * public registry is unreachable that configuration is the only thing that
 * works.
 *
 * The *download* is the one thing npm does not do for us: it is handled by
 * `electron/tarball-cache.js`, which streams tarballs into npm's cache with real
 * progress, resumable `.part` files and mirror failover. The install then runs
 * offline, so a slow network can no longer turn into a half-installed runtime.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const {
  downloadAll,
  planSizes,
  fileNameFor,
  formatBytes,
  formatDuration,
  UpdateCancelledError,
} = require('./tarball-cache');

const DSH_PACKAGE = '@deepseek-ai/dsh';
/** Selectable update channels, mapped onto npm dist-tags. */
const CHANNELS = ['next', 'alpha', 'latest'];
const DEFAULT_CHANNEL = 'next';
/**
 * Registries offered in the UI. `url: null` means "leave npm alone", i.e. use
 * whatever the machine's own npm configuration (`.npmrc`, proxy, mirror) says.
 */
const MIRRORS = [
  { id: 'auto', label: '跟随 npm 配置（~/.npmrc）', url: null, hint: '使用本机 npm 自己的 registry' },
  { id: 'npmmirror', label: '淘宝 npmmirror', url: 'https://registry.npmmirror.com/', hint: '国内镜像，通常最快' },
  { id: 'tencent', label: '腾讯云', url: 'https://mirrors.cloud.tencent.com/npm/', hint: '国内镜像' },
  { id: 'huawei', label: '华为云', url: 'https://repo.huaweicloud.com/repository/npm/', hint: '国内镜像' },
  { id: 'tuna', label: '清华 TUNA', url: 'https://mirrors.tuna.tsinghua.edu.cn/npm/', hint: '教育网镜像' },
  { id: 'ustc', label: '中科大 USTC', url: 'https://npmreg.proxy.ustclug.org/', hint: '教育网镜像' },
  { id: 'npmjs', label: 'npm 官方', url: 'https://registry.npmjs.org/', hint: '海外官方源' },
];
const DEFAULT_MIRROR_ID = 'auto';
/** Boot failures on an installed runtime before it is rolled back. */
const BOOT_FAILURE_LIMIT = 2;
const PROBE_TIMEOUT_MS = 60000;
const INSTALL_TIMEOUT_MS = 45 * 60 * 1000;
/** Resolving the dependency tree is metadata-only; it is still worth a ceiling. */
const RESOLVE_TIMEOUT_MS = 10 * 60 * 1000;
/** Downloaded tarballs older than this are dropped after a successful install. */
const TARBALL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
  const updateCacheDir = path.join(userDataDir, 'update-cache');
  const tarballsDir = path.join(updateCacheDir, 'tarballs');
  const stateFile = path.join(userDataDir, 'runtime-state.json');

  // ── state ──────────────────────────────────────────────────────────────────

  function readState() {
    const stored = readJson(stateFile) ?? {};
    return {
      channel: CHANNELS.includes(stored.channel) ? stored.channel : DEFAULT_CHANNEL,
      registryId: MIRRORS.some((mirror) => mirror.id === stored.registryId)
        ? stored.registryId
        : DEFAULT_MIRROR_ID,
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

  /** The mirror record for an id, falling back to the saved one. */
  function mirrorFor(registryId) {
    const id = MIRRORS.some((mirror) => mirror.id === registryId) ? registryId : readState().registryId;
    return MIRRORS.find((mirror) => mirror.id === id) ?? MIRRORS[0];
  }

  /** The registry URL to hand npm, or null to leave the machine's npm alone. */
  function registryUrlFor(registryId) {
    return mirrorFor(registryId).url;
  }

  function npmEnv(registry) {
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
    if (typeof registry === 'string' && registry !== '') {
      // An explicit registry beats ~/.npmrc (npm's own precedence for
      // npm_config_registry), which is what makes the mirror switch take effect
      // for both the probe and the install.
      env.npm_config_registry = registry;
    }
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
  async function check({ channel, registryId } = {}) {
    assertBundledNpm();
    const state = readState();
    const useChannel = CHANNELS.includes(channel) ? channel : state.channel;
    const mirror = mirrorFor(registryId);
    const current = resolve().version;

    const result = await run(
      nodeExe,
      [npmCli, 'view', DSH_PACKAGE, 'dist-tags', '--json'],
      { env: npmEnv(mirror.url), timeoutMs: PROBE_TIMEOUT_MS },
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
    return {
      channel: useChannel,
      current,
      latest,
      updateAvailable,
      tags,
      registryId: mirror.id,
      registry: mirror.url,
      state: next,
    };
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
   * Resolve the dependency tree without downloading it, so the downloader knows
   * exactly which tarballs the install needs. `--package-lock-only` fetches
   * metadata only; the tarballs are ours to fetch.
   * @returns {Array<{name: string, version: string, url: string, integrity?: string}>}
   */
  async function resolveTree(staging, registry, { write, controller }) {
    const result = await run(
      nodeExe,
      [
        npmCli,
        'install',
        '--package-lock-only',
        '--omit=dev',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--loglevel=error',
      ],
      { cwd: staging, env: npmEnv(registry), timeoutMs: RESOLVE_TIMEOUT_MS },
    );
    controller?.throwIfCancelled();
    if (result.code !== 0) {
      const detail = result.stderr.trim().split(/\r?\n/).slice(-4).join(' ');
      throw new Error(`解析依赖树失败（npm ${result.code}）：${detail}`);
    }

    const lock = readJson(path.join(staging, 'package-lock.json'));
    if (lock === null || typeof lock.packages !== 'object' || lock.packages === null) {
      throw new Error('npm 未生成 package-lock.json，无法得到下载清单');
    }
    const entries = [];
    for (const [key, meta] of Object.entries(lock.packages)) {
      if (key === '' || meta === null || typeof meta !== 'object') continue;
      if (meta.link === true || meta.dev === true) continue;
      // Optional dependencies that cannot run on this platform are skipped:
      // they would add hundreds of megabytes for nothing, and npm would not
      // install them anyway. Matching ones are kept, because npm will.
      if (meta.optional === true && !matchesPlatform(meta)) continue;
      if (typeof meta.resolved !== 'string' || !/^https?:/.test(meta.resolved)) continue;
      if (typeof meta.version !== 'string') continue;
      entries.push({
        name: key.replace(/^.*node_modules\//, ''),
        version: meta.version,
        url: meta.resolved,
        integrity: typeof meta.integrity === 'string' ? meta.integrity : undefined,
        size: null,
      });
    }
    if (entries.length === 0) throw new Error('npm 解析出的依赖清单为空');
    return entries;
  }

  /**
   * Store the downloaded tarballs in npm's content-addressed cache, so the
   * install finds them locally and never touches the network. Falls back to
   * `npm cache add` (one process per tarball) if the bundled cacache cannot be
   * loaded.
   */
  async function seedCache(files, { write, onProgress, controller }) {
    const cacache = loadCacache();
    const cachePath = path.join(cacheDir, '_cacache');
    let done = 0;
    for (const file of files) {
      controller?.throwIfCancelled();
      await controller?.waitWhilePaused();
      if (cacache !== null) {
        try {
          const integrity = typeof file.integrity === 'string' ? file.integrity : '';
          if (integrity !== '') {
            const present = await cacache.get.hasContent(cachePath, integrity).catch(() => null);
            if (present !== null && present !== undefined && present !== false) {
              done += 1;
              onProgress?.({ done, total: files.length });
              continue;
            }
            await pipeline(
              fs.createReadStream(file.path),
              cacache.put.stream(cachePath, integrity, { integrity }),
            );
          } else {
            await pipeline(
              fs.createReadStream(file.path),
              cacache.put.stream(cachePath, `dsh-tarball:${path.basename(file.path)}`),
            );
          }
        } catch (error) {
          write(`update: 写入 npm 缓存失败（${path.basename(file.path)}）：${error.message}`);
        }
      } else {
        const result = await run(nodeExe, [npmCli, 'cache', 'add', file.path, '--loglevel=error'], {
          env: npmEnv(null),
          timeoutMs: PROBE_TIMEOUT_MS * 5,
        });
        if (result.code !== 0) {
          const detail = result.stderr.trim().split(/\r?\n/).slice(-2).join(' ');
          write(`update: npm cache add 失败（${path.basename(file.path)}）：${detail}`);
        }
      }
      done += 1;
      onProgress?.({ done, total: files.length });
    }
    return done;
  }

  /** npm ships cacache; using it directly avoids one process per tarball. */
  function loadCacache() {
    const candidate = path.join(
      bundledRuntimeDir,
      'node',
      'node_modules',
      'npm',
      'node_modules',
      'cacache',
    );
    try {
      return fs.existsSync(candidate) ? require(candidate) : null;
    } catch {
      return null;
    }
  }

  /**
   * Install `version` into the runtime store and switch to it.
   *
   * The download is ours (resumable, mirror-failover, real progress); npm only
   * resolves the tree and then installs offline from the cache we filled.
   *
   * @param {string} version
   * @param {object} [options]
   * @param {string} [options.registryId]  mirror id; default is the saved one
   * @param {(progress: object) => void} [options.onProgress]
   * @param {object} [options.controller]  from `createUpdateController()`
   */
  async function install(version, { registryId, onProgress = () => {}, controller, log: logLine } = {}) {
    assertBundledNpm();
    if (parseVersion(version) === null) throw new Error(`not a version: ${version}`);
    const write = typeof logLine === 'function' ? logLine : log;

    const target = installedRoot(version);
    const existing = inspect(target);
    if (existing !== null) {
      onProgress({ phase: 'activate', version, reused: true });
      activate(version);
      return { version, root: target, reused: true };
    }

    const mirror = mirrorFor(registryId);
    // Every other mirror, as a retry target for an individual tarball.
    const otherBases = MIRRORS.map((entry) => entry.url).filter(
      (url) => typeof url === 'string' && url !== mirror.url,
    );

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

    try {
      onProgress({ phase: 'resolve', version, registryId: mirror.id, registry: mirror.url });
      write(
        `update: 解析 ${DSH_PACKAGE}@${version} 的依赖树（registry=${mirror.url ?? '~/.npmrc'}）`,
      );
      const entries = await resolveTree(staging, mirror.url, { write, controller });
      write(`update: 需要下载 ${entries.length} 个 tarball`);

      onProgress({ phase: 'plan', version, total: entries.length, planned: 0, totalBytes: 0, unknown: 0 });
      await planSizes(entries, {
        controller,
        log: write,
        onProgress: (progress) => onProgress({ phase: 'plan', version, ...progress }),
      });

      const downloaded = await downloadAll(entries, {
        dir: tarballsDir,
        controller,
        log: write,
        fallbackUrls: otherBases,
        onProgress: (progress) => onProgress({ phase: 'download', version, ...progress }),
      });
      write(
        `update: 下载完成 ${downloaded.files} 个包 / ${formatBytes(downloaded.bytes)} / ${formatDuration(downloaded.seconds)}`,
      );

      onProgress({ phase: 'seed', version, done: 0, total: entries.length });
      await seedCache(
        entries.map((entry) => ({
          path: path.join(tarballsDir, fileNameFor(entry)),
          integrity: entry.integrity,
        })),
        { write, controller, onProgress: ({ done, total }) => onProgress({ phase: 'seed', version, done, total }) },
      );

      onProgress({ phase: 'install', version });
      write(`update: 从本地缓存安装到 ${staging}`);
      const installed = await run(
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
          // Cache-first: everything was just downloaded, so this normally means
          // "no network at all"; it still falls back to the registry for a
          // platform-specific optional package we chose not to pre-fetch.
          '--prefer-offline',
          '--loglevel=error',
        ],
        { cwd: staging, env: npmEnv(mirror.url), timeoutMs: INSTALL_TIMEOUT_MS },
      );
      if (installed.code !== 0) {
        const detail = installed.stderr.trim().split(/\r?\n/).slice(-4).join(' ');
        throw new Error(`npm install failed (${installed.code}): ${detail}`);
      }
      controller?.throwIfCancelled();

      onProgress({ phase: 'verify', version });
      const staged = inspect(staging);
      if (staged === null) {
        throw new Error(
          `the installed tree failed validation (missing entry point, Web assets, or mismatched family versions)`,
        );
      }

      onProgress({ phase: 'activate', version });
      rmTree(target);
      fs.renameSync(staging, target);
      activate(version);
      pruneTarballs();

      // Report the Node the interpreter will use, so an engines bump that needs a
      // newer Node is visible in the log rather than only as a later boot failure.
      const engines = readJson(path.join(target, 'node_modules', DSH_PACKAGE, 'package.json'))?.engines;
      if (engines?.node !== undefined) {
        write(
          `runtime ${version} declares engines.node=${engines.node}; bundled interpreter is ${process.version}`,
        );
      }

      write(`activated runtime ${version}`);
      return { version, root: target, reused: false };
    } catch (error) {
      // The staging tree is unusable either way; the downloaded tarballs are
      // deliberately kept, so cancelling and retrying resumes instead of
      // starting over.
      rmTree(staging);
      throw error;
    }
  }

  /** Drop tarballs from updates nobody will resume any more. */
  function pruneTarballs() {
    if (!fs.existsSync(tarballsDir)) return;
    const now = Date.now();
    for (const entry of fs.readdirSync(tarballsDir)) {
      const file = path.join(tarballsDir, entry);
      try {
        if (now - fs.statSync(file).mtimeMs > TARBALL_TTL_MS) fs.rmSync(file, { force: true });
      } catch {
        /* a file we cannot inspect is not worth failing the install for */
      }
    }
  }

  /**
   * Probe every mirror and report latency and throughput.
   * The packument is the first thing an update check fetches, so timing it is
   * the closest thing to timing the update itself — and it is small enough to
   * repeat on all mirrors in parallel.
   */
  async function testMirrors({ timeoutMs = 20000, capBytes = 2 * 1024 * 1024 } = {}) {
    const targets = MIRRORS.filter((mirror) => typeof mirror.url === 'string');
    const results = await Promise.all(
      targets.map(async (mirror) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const started = Date.now();
        let firstByteAt = null;
        let bytes = 0;
        try {
          const response = await fetch(`${mirror.url}${DSH_PACKAGE.replace('/', '%2f')}`, {
            headers: { 'user-agent': 'dsh-desktop-update/1.0', 'accept-encoding': 'identity' },
            signal: controller.signal,
          });
          firstByteAt = Date.now();
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          for await (const chunk of response.body) {
            bytes += chunk.length;
            if (bytes >= capBytes) break;
          }
        } catch (error) {
          return {
            id: mirror.id,
            label: mirror.label,
            url: mirror.url,
            ok: false,
            error: error.name === 'AbortError' ? '超时' : error.message,
          };
        } finally {
          clearTimeout(timer);
        }
        const elapsed = Math.max(1, Date.now() - started) / 1000;
        return {
          id: mirror.id,
          label: mirror.label,
          url: mirror.url,
          ok: true,
          latencyMs: firstByteAt === null ? null : firstByteAt - started,
          bytes,
          bytesPerSecond: bytes / elapsed,
          elapsedMs: Date.now() - started,
        };
      }),
    );
    return results.sort((a, b) => {
      if (a.ok !== b.ok) return a.ok ? -1 : 1;
      return (b.bytesPerSecond ?? 0) - (a.bytesPerSecond ?? 0);
    });
  }

  /** Whether a lockfile entry's `os`/`cpu` guards allow it on this machine. */
  function matchesPlatform(meta) {
    const check = (list, actual) => {
      if (!Array.isArray(list) || list.length === 0) return true;
      let allowed = false;
      for (const raw of list) {
        if (typeof raw !== 'string') continue;
        const negated = raw.startsWith('!');
        const value = negated ? raw.slice(1) : raw;
        if (value !== actual) continue;
        if (negated) return false;
        allowed = true;
      }
      return allowed;
    };
    return check(meta.os, process.platform) && check(meta.cpu, process.arch);
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

  /** Persist the chosen mirror (used by the menu's 更新镜像源 submenu). */
  function setMirror(registryId) {
    const mirror = mirrorFor(registryId);
    writeState({ registryId: mirror.id });
    return mirror;
  }

  return {
    CHANNELS,
    MIRRORS,
    DEFAULT_MIRROR_ID,
    paths: {
      bundledRuntimeDir,
      bundledAppDir,
      nodeExe,
      npmCli,
      runtimesDir,
      cacheDir,
      updateCacheDir,
      tarballsDir,
      stateFile,
    },
    readState,
    writeState,
    mirrorFor,
    registryUrlFor,
    setMirror,
    resolve,
    check,
    install,
    testMirrors,
    pruneTarballs,
    activate,
    rollback,
    noteBootSuccess,
    recordBootFailure,
    prune,
    describe,
    cleanStaging,
  };
}

module.exports = {
  createRuntimeManager,
  compareVersions,
  CHANNELS,
  DEFAULT_CHANNEL,
  MIRRORS,
  DEFAULT_MIRROR_ID,
  BOOT_FAILURE_LIMIT,
  UpdateCancelledError,
};
