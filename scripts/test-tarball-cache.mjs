/**
 * Exercises the update downloader (`electron/tarball-cache.js`) without Electron.
 *
 * The downloader is the part of the update path that replaced npm's own fetch, so
 * its promises — real byte counts, a resumable `.part` file, mirror failover — are
 * exactly what the progress window shows the user. This drives it two ways:
 *
 *   1. against the real registry: plan sizes, download two real tarballs, verify
 *      the published integrity, and watch the aggregate progress snapshot;
 *   2. against a local registry that streams slowly and honours `Range`, so the
 *      pause / cancel / resume paths are deterministic instead of depending on how
 *      fast the network happens to be that day.
 *
 * Usage:
 *   node scripts/test-tarball-cache.mjs              everything
 *   node scripts/test-tarball-cache.mjs --offline     only the local-registry half
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const offline = process.argv.includes('--offline');

const {
  createUpdateController,
  downloadAll,
  planSizes,
  verifyFile,
  rewriteTarballUrl,
  fileNameFor,
  formatBytes,
  formatDuration,
  UpdateCancelledError,
} = require(path.join(projectRoot, 'electron', 'tarball-cache.js'));

const sandbox = path.join(projectRoot, '.tarball-cache-test');
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });

const failures = [];
let checks = 0;

/** Assert one property, print it, and remember it if it is false. */
function check(label, ok, detail = '') {
  checks += 1;
  if (ok !== true) failures.push(label);
  console.log(`  ${ok === true ? '✔' : '✘'} ${label}${detail === '' ? '' : `  ${detail}`}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── a registry that streams slowly and honours Range ─────────────────────────

function serveSlow(payload, { chunkSize = 65536, delayMs = 25 } = {}) {
  const requests = [];
  const integrity = `sha512-${createHash('sha512').update(payload).digest('base64')}`;
  const server = http.createServer((request, response) => {
    const range = typeof request.headers.range === 'string' ? request.headers.range : null;
    const match = range === null ? null : /^bytes=(\d+)-$/.exec(range);
    const start = match === null ? 0 : Number(match[1]);
    if (start >= payload.length) {
      requests.push({ range, status: 416 });
      response.writeHead(416, { 'content-range': `bytes */${payload.length}` });
      response.end();
      return;
    }
    const status = match === null ? 200 : 206;
    requests.push({ range, status, start });
    const headers = { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes' };
    if (status === 206) headers['content-range'] = `bytes ${start}-${payload.length - 1}/${payload.length}`;
    response.writeHead(status, headers);
    let offset = start;
    let stopped = false;
    response.on('close', () => {
      stopped = true;
    });
    const pump = () => {
      if (stopped || offset >= payload.length) {
        if (!stopped) response.end();
        return;
      }
      const end = Math.min(offset + chunkSize, payload.length);
      response.write(payload.subarray(offset, end));
      offset = end;
      setTimeout(pump, delayMs);
    };
    pump();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        requests,
        url: `http://127.0.0.1:${port}/slow-package/-/slow-package-1.0.0.tgz`,
        size: payload.length,
        integrity,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

// ── real registry ────────────────────────────────────────────────────────────

async function dist(pkg, version) {
  const response = await fetch(`https://registry.npmmirror.com/${pkg}`);
  const packument = await response.json();
  const entry = packument.versions[version];
  return { name: pkg, version, url: entry.dist.tarball, integrity: entry.dist.integrity };
}

async function realRegistryHalf() {
  const small = await dist('is-number', '7.0.0');
  const big = await dist('typescript', '5.6.3');
  console.log(`\nreal registry: ${small.name}@${small.version}, ${big.name}@${big.version}`);

  const plan = await planSizes([small, big]);
  check(
    'planSizes measures every tarball',
    plan.totalBytes > 0 && small.size === 3730 && (big.size ?? 0) > 1000000 && plan.unknown === 0,
    `total=${formatBytes(plan.totalBytes)} big=${formatBytes(big.size)}`,
  );

  const unknown = await planSizes([
    { name: 'x', version: '1.0.0', url: 'https://registry.npmmirror.com/definitely-missing-xyz/-/x-1.0.0.tgz' },
  ]);
  check('an unmeasurable tarball is tolerated', unknown.unknown === 1 && unknown.totalBytes === 0);

  const snapshots = [];
  const result = await downloadAll([small], {
    dir: sandbox,
    controller: createUpdateController(),
    onProgress: (progress) => snapshots.push(progress),
  });
  const file = path.join(sandbox, fileNameFor(small));
  check(
    'download + verify a real tarball',
    result.files === 1 &&
      statSync(file).size === 3730 &&
      (await verifyFile(file, small.integrity)) === true &&
      snapshots.some((snapshot) => snapshot.percent === 100) &&
      Number.isFinite(snapshots.at(-1)?.elapsedSeconds),
    `${formatBytes(result.bytes)} in ${result.seconds.toFixed(1)}s, percent reached ${snapshots.at(-1)?.percent}`,
  );
  check(
    'a wrong integrity is rejected',
    (await verifyFile(file, `sha512-${'A'.repeat(86)}==`)) === false,
  );

  const large = await downloadAll([big], { dir: sandbox, controller: createUpdateController() });
  check(
    'a multi-megabyte tarball verifies too',
    large.bytes > 4000000 && (await verifyFile(path.join(sandbox, fileNameFor(big)), big.integrity)) === true,
    `${formatBytes(large.bytes)} in ${large.seconds.toFixed(1)}s`,
  );

  // The CLI updater test and any non-UI caller omit the controller entirely;
  // that used to throw on the very first progress report.
  const bare = await downloadAll([small], { dir: sandbox });
  check(
    'a caller with no controller still downloads',
    bare.files === 1 && bare.bytes === 3730,
    `${formatBytes(bare.bytes)} without pause/cancel support`,
  );

  return small;
}

// ── local slow registry: pause, cancel, resume ───────────────────────────────

async function localRegistryHalf(smallUrl) {
  const payload = randomBytes(8 * 1024 * 1024);
  const server = await serveSlow(payload);
  const entry = {
    name: 'slow-package',
    version: '1.0.0',
    url: server.url,
    integrity: server.integrity,
    size: server.size,
  };
  console.log(`\nlocal registry: ${formatBytes(server.size)} streamed in ~3s on ${server.url}`);

  // pause before the first byte
  const controller = createUpdateController();
  controller.pause();
  const whilePaused = [];
  let finished = false;
  const run = downloadAll([entry], {
    dir: sandbox,
    controller,
    onProgress: (progress) => whilePaused.push(progress),
  }).then((value) => {
    finished = true;
    return value;
  });
  await sleep(1200);
  const heldFor1s = finished === false;
  const bytesWhilePaused = whilePaused.at(-1)?.bytes ?? -1;
  const reportedPaused = whilePaused.some((snapshot) => snapshot.paused === true);
  controller.resume();
  const paused = await run;
  check(
    'pause stops the transfer before the first byte',
    heldFor1s && bytesWhilePaused === 0 && reportedPaused,
    `held=${heldFor1s} bytes=${bytesWhilePaused}`,
  );
  const file = path.join(sandbox, fileNameFor(entry));
  check(
    'resume finishes and verifies',
    paused.bytes === server.size && (await verifyFile(file, server.integrity)) === true,
    `${formatBytes(paused.bytes)} in ${paused.seconds.toFixed(1)}s`,
  );

  // cancel mid-transfer: the .part file must survive
  rmSync(file, { force: true });
  rmSync(`${file}.part`, { force: true });
  const cancelController = createUpdateController();
  let cancelAt = 0;
  const cancelled = await downloadAll([entry], {
    dir: sandbox,
    controller: cancelController,
    onProgress: (progress) => {
      if (progress.bytes > 0 && progress.bytes < server.size) {
        cancelAt = progress.bytes;
        cancelController.cancel();
      }
    },
  }).then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error }),
  );
  const part = existsSync(`${file}.part`) ? statSync(`${file}.part`).size : 0;
  check(
    'cancel throws UpdateCancelledError and keeps the .part file',
    cancelled.ok === false &&
      cancelled.error instanceof UpdateCancelledError &&
      part > 0 &&
      part < server.size &&
      existsSync(file) === false,
    `cancelled after ${formatBytes(cancelAt)}, .part=${formatBytes(part)}`,
  );

  // the retry must ask for the remaining bytes, not restart
  const before = server.requests.length;
  const resumed = await downloadAll([entry], { dir: sandbox, controller: createUpdateController() });
  const requests = server.requests.slice(before);
  check(
    'retry resumes with a Range request from the .part offset',
    requests.some((request) => request.range === `bytes=${part}-` && request.status === 206) &&
      resumed.bytes + part >= server.size &&
      resumed.bytes < server.size &&
      (await verifyFile(file, server.integrity)) === true,
    `${JSON.stringify(requests[0])} → ${formatBytes(resumed.bytes)} new bytes`,
  );

  await server.close();

  const rewritten = rewriteTarballUrl(
    smallUrl ?? 'https://registry.npmmirror.com/is-number/-/is-number-7.0.0.tgz',
    'https://repo.huaweicloud.com/repository/npm/',
  );
  check(
    'tarball urls are rewritten per mirror',
    rewritten.startsWith('https://repo.huaweicloud.com/repository/npm/') &&
      rewritten.endsWith('/is-number/-/is-number-7.0.0.tgz'),
    rewritten,
  );
  check(
    'formatters',
    formatBytes(0) === '0 B' && formatBytes(1536) === '1.5 KB' && /分/.test(formatDuration(125)) && formatDuration(0) === '--',
    `${formatBytes(1536)} / ${formatDuration(125)}`,
  );
}

async function main() {
  const smallUrl = offline ? null : (await realRegistryHalf()).url;
  await localRegistryHalf(smallUrl);
  rmSync(sandbox, { recursive: true, force: true });
  const passed = checks - failures.length;
  console.log(`\n${passed}/${checks} checks passed`);
  if (failures.length > 0) {
    console.log(`failed: ${failures.join('; ')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`\nFAILED: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
