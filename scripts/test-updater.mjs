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

// ── 2/3/4. install, activate, roll back ──────────────────────────────────────

if (checkOnly) {
  console.log('\n--check-only: skipping install/activate/rollback');
} else {
  const target = [...probes.values()].find((result) => result.updateAvailable);
  if (target === undefined) {
    console.log('\n2. no channel offers a newer version; nothing to install');
  } else {
    console.log(`\n2. install DSH ${target.latest} (this downloads the full runtime)`);
    const started = Date.now();
    const installed = await manager.install(target.latest, {
      onProgress: ({ phase }) => console.log(`    phase: ${phase}`),
    });
    console.log(`    installed in ${((Date.now() - started) / 1000).toFixed(1)}s (reused=${installed.reused})`);

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
