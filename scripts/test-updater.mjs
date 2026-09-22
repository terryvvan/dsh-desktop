/**
 * Exercises the shell's runtime updater without launching Electron.
 *
 * It points the real manager at the real bundled runtime, uses a throwaway user
 * data directory, and drives the same code paths the app does:
 *
 *   1. probe every channel and print what each one resolves to
 *   2. install the newest available version into the runtime store
 *   3. confirm the shell would now boot the installed tree
 *   4. roll back and confirm the shell returns to the bundled tree
 *
 * Usage:
 *   node scripts/test-updater.mjs              probe + install + activate + rollback
 *   node scripts/test-updater.mjs --check-only probe only, no download
 *   node scripts/test-updater.mjs --boot       also boot the installed runtime and
 *                                              confirm it serves the Web GUI
 *   node scripts/test-updater.mjs --mirrors    also run the mirror speed test
 *   node scripts/test-updater.mjs --install 0.1.5-rc.2
 *                                              install this version even when no
 *                                              channel offers something newer
 *   node scripts/test-updater.mjs --keep       leave the downloaded runtime in place
 */

import { mkdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

const { createRuntimeManager, CHANNELS } = require(path.join(projectRoot, 'electron', 'updater.js'));

const checkOnly = process.argv.includes('--check-only');
const keep = process.argv.includes('--keep');
const boot = process.argv.includes('--boot');
const mirrors = process.argv.includes('--mirrors');
const forced = (() => {
  const at = process.argv.indexOf('--install');
  return at === -1 ? null : (process.argv[at + 1] ?? null);
})();

const sandbox = path.join(projectRoot, '.updater-test');
if (!keep && !checkOnly) rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });

const manager = createRuntimeManager({
  bundledRuntimeDir: path.join(projectRoot, 'runtime'),
  userDataDir: sandbox,
  log: (message) => console.log(`    [updater] ${message}`),
});

const bundled = manager.describe();
console.log(`bundled runtime : DSH ${bundled.bundled}`);
console.log(`bundled npm     : ${manager.paths.npmCli}`);
console.log(`sandbox         : ${sandbox}\n`);

let failures = 0;
const check = (label, condition, extra = '') => {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  ${extra}`}`);
  if (!condition) failures += 1;
};

/** GET following redirects, carrying Set-Cookie forward. */
function fetchFollowing(url, cookie = '', chain = [], depth = 0) {
  return new Promise((resolve) => {
    if (depth > 5) {
      resolve({ code: 0, boot: false, bytes: 0, chain, error: 'too many redirects' });
      return;
    }
    const request = httpRequest(url, { headers: cookie === '' ? {} : { cookie } }, (response) => {
      const { statusCode, headers } = response;
      const hop = { code: statusCode };
      chain.push(hop);
      const carried =
        headers['set-cookie'] === undefined
          ? cookie
          : headers['set-cookie'].map((entry) => entry.split(';')[0]).join('; ');

      if (statusCode >= 300 && statusCode < 400 && headers.location !== undefined) {
        response.resume();
        resolve(fetchFollowing(new URL(headers.location, url).href, carried, chain, depth + 1));
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        hop.bytes = body.length;
        resolve({ code: statusCode, boot: body.includes('__DSH_BOOT__'), bytes: body.length, chain });
      });
    });
    request.on('error', (error) =>
      resolve({ code: 0, boot: false, bytes: 0, chain, error: error.message }),
    );
    request.setTimeout(60000, () => request.destroy(new Error('timeout')));
    // Unlike http.get(), http.request() does not send anything until end().
    request.end();
  });
}

// ── 1. probe every channel ───────────────────────────────────────────────────

console.log('1. channel probe');
const probes = new Map();
for (const channel of CHANNELS) {
  try {
    const result = await manager.check({ channel });
    probes.set(channel, result);
    console.log(
      `  ${channel.padEnd(7)} registry=${result.latest.padEnd(16)} current=${result.current}  update=${result.updateAvailable}`,
    );
  } catch (error) {
    console.log(`  ${channel.padEnd(7)} ERROR ${error.message}`);
    failures += 1;
  }
}
check('at least one channel resolved', probes.size > 0);

// ── 1b. mirrors ──────────────────────────────────────────────────────────────

console.log('\n1b. download mirrors');
const mirrorList = manager.MIRRORS;
console.log(`  ${mirrorList.map((mirror) => `${mirror.id}${mirror.url === null ? '' : `=${mirror.url}`}`).join('\n  ')}`);
check(
  'the mirror list is offered with urls',
  Array.isArray(mirrorList) && mirrorList.some((mirror) => mirror.id === 'auto') &&
    mirrorList.filter((mirror) => typeof mirror.url === 'string').length >= 5,
  `${mirrorList.length} entries`,
);
check(
  'mirrorFor resolves a known id',
  manager.mirrorFor('huawei').id === 'huawei' && manager.mirrorFor('huawei').url.startsWith('https://'),
  manager.mirrorFor('huawei').url,
);
check('an unknown mirror id falls back to auto', manager.mirrorFor('no-such-mirror').id === 'auto');
const chosen = await manager.check({ channel: 'next', registryId: 'npmmirror' });
check(
  'a check honours the selected mirror',
  chosen.registryId === 'npmmirror' && chosen.registry === manager.mirrorFor('npmmirror').url,
  `${chosen.registryId} → ${chosen.registry}`,
);
manager.setMirror('huawei');
check('the selected mirror is persisted', manager.readState().registryId === 'huawei');
manager.setMirror('auto');

if (mirrors) {
  console.log('\n1c. mirror speed test (network)');
  const results = await manager.testMirrors({ timeoutMs: 20000 });
  for (const result of results) {
    console.log(
      `  ${result.id.padEnd(10)} ${result.ok === true ? `${String(result.latencyMs).padStart(5)}ms  ${(result.bytesPerSecond / 1024).toFixed(0).padStart(6)} KB/s` : `ERROR ${result.error}`}`,
    );
  }
  check('at least one mirror answered the speed test', results.some((result) => result.ok === true));
}

// ── 2/3/4. install, activate, roll back ──────────────────────────────────────

if (checkOnly) {
  console.log('\n--check-only: skipping install/activate/rollback');
} else {
  const target =
    forced === null
      ? [...probes.values()].find((result) => result.updateAvailable)
      : { latest: forced, updateAvailable: true, forced: true };
  if (target === undefined) {
    console.log('\n2. no channel offers a newer version; nothing to install');
  } else {
    console.log(`\n2. install DSH ${target.latest} (this downloads the full runtime)`);
    const started = Date.now();
    // The progress window is fed by these events, so check the contract here
    // rather than trusting that the window simply looked busy.
    const phases = [];
    const downloads = [];
    const installed = await manager.install(target.latest, {
      onProgress: (progress) => {
        phases.push(progress.phase);
        if (progress.phase === 'download') downloads.push(progress);
        const detail =
          progress.phase === 'plan'
            ? ` ${progress.planned}/${progress.total} 个包`
            : progress.phase === 'download'
              ? ` ${progress.percent}% ${(progress.bytes / 1048576).toFixed(1)}MB`
              : '';
        console.log(`    phase: ${progress.phase}${detail}`);
      },
    });
    console.log(`    installed in ${((Date.now() - started) / 1000).toFixed(1)}s (reused=${installed.reused})`);

    if (installed.reused === true) {
      console.log('    (tree already present, so the download path was not exercised)');
    } else {
      const seen = new Set(phases);
      check(
        'the install walks every advertised phase',
        ['resolve', 'plan', 'download', 'seed', 'install', 'verify', 'activate'].every((phase) => seen.has(phase)),
        [...seen].join(' → '),
      );
      const plan = phases.filter((phase) => phase === 'plan').length;
      const last = downloads.at(-1);
      check(
        'the plan phase reports how many tarballs it measured',
        plan > 1 && downloads.length > 1,
        `${plan} plan events, ${downloads.length} download events`,
      );
      check(
        'the download reports a real, complete progress snapshot',
        last !== undefined &&
          last.percent === 100 &&
          last.bytes === last.totalBytes &&
          last.files === last.totalFiles &&
          Number.isFinite(last.speed) &&
          last.paused === false,
        last === undefined ? 'no download events' : `${last.files}/${last.totalFiles} files, ${(last.bytes / 1048576).toFixed(1)}MB, ${(last.speed / 1048576).toFixed(2)}MB/s`,
      );
    }

    const resolved = manager.resolve();
    check('shell resolves the installed tree', resolved.source === 'installed', resolved.root);
    check('resolved version matches', resolved.version === target.latest, String(resolved.version));
    check('bundled tree untouched', manager.describe().bundled === bundled.bundled);

    // Downloading a version proves nothing about whether it runs. Booting it is
    // the only check that matters, so do that against an isolated DSH home.
    if (boot) {
      console.log('\n2b. boot the installed runtime');
      const home = path.join(sandbox, 'dsh-home');
      mkdirSync(home, { recursive: true });
      const child = spawn(
        manager.paths.nodeExe,
        [resolved.dshBin, 'web', '--port', '0', '--no-open'],
        {
          cwd: sandbox,
          env: { ...process.env, DSH_HOME: home, ELECTRON_RUN_AS_NODE: undefined },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false,
        },
      );
      let stdout = '';
      const url = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 240000);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
          const match = /dsh web:\s+(https?:\/\/\S+)/.exec(stdout);
          if (match !== null) {
            clearTimeout(timer);
            resolve(match[1]);
          }
        });
        child.on('exit', () => {
          clearTimeout(timer);
          resolve(null);
        });
      });

      if (url === null) {
        check('installed runtime reports a listening address', false, stdout.trim().split('\n').slice(-3).join(' | '));
      } else {
        check('installed runtime reports a listening address', true, url.replace(/\?.*$/u, ''));
        // The token handshake is not stable across versions: 0.1.5-rc.2 answers
        // the token URL with 200 directly, while 0.1.6-alpha.2 answers 303 and
        // mints the cookie on the way to `/`. Chromium follows that
        // transparently, so this check must follow it too, carrying the cookie.
        // The address line can also land slightly before the socket accepts
        // requests, so probe with retries instead of a single shot.
        let status = { code: 0, boot: false, bytes: 0, chain: [], error: 'not attempted' };
        for (let attempt = 1; attempt <= 5; attempt += 1) {
          status = await fetchFollowing(url);
          console.log(
            `    probe ${attempt}: ${status.error ?? `HTTP ${status.chain.map((s) => s.code).join(' -> ')}`} boot=${status.boot} bytes=${status.bytes}`,
          );
          if (status.code === 200 && status.boot === true) break;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 4000));
        }
        check(
          'installed runtime serves the Web GUI',
          status.code === 200 && status.boot === true,
          JSON.stringify({ code: status.code, boot: status.boot, bytes: status.bytes }),
        );
      }

      child.kill();
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5000);
        child.on('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    console.log('\n3. boot-failure handling');
    const first = manager.recordBootFailure('simulated boot failure');
    check('first failure does not roll back', first.rolledBack === false);
    const second = manager.recordBootFailure('simulated boot failure');
    check('second failure rolls back', second.rolledBack === true, JSON.stringify(second));
    const after = manager.resolve();
    check('dangerous version is skipped', manager.readState().skippedVersion === target.latest);
    console.log(`    now resolves: DSH ${after.version} (${after.source})`);

    console.log('\n4. manual rollback to bundled');
    manager.rollback('test');
    const final = manager.resolve();
    check('falls back to bundled runtime', final.source === 'bundled', String(final.version));
  }
}

console.log(`\n${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}`);
if (!keep) rmSync(sandbox, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
