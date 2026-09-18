/**
 * Fetches the Electron runtime binary and unpacks it into
 * node_modules/electron/dist — the exact layout electron and electron-builder
 * expect. This exists because `npm install electron` runs its own postinstall
 * downloader, which some restricted shells refuse to spawn; doing the fetch
 * here keeps the build reproducible without relying on lifecycle scripts.
 */

import { createWriteStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { get } from 'node:https';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const electronDir = path.join(projectRoot, 'node_modules', 'electron');
const distDir = path.join(electronDir, 'dist');
const cacheDir = path.resolve(projectRoot, '..', '.npm-cache');

const { version } = require(path.join(electronDir, 'package.json'));
const platform = process.env.npm_config_platform ?? 'win32';
const arch = process.env.npm_config_arch ?? 'x64';
const slug = `electron-v${version}-${platform}-${arch}`;
const zipPath = path.join(cacheDir, `${slug}.zip`);

const MIRRORS = [
  `https://registry.npmmirror.com/-/binary/electron/${version}/${slug}.zip`,
  `https://cdn.npmmirror.com/binaries/electron/${version}/${slug}.zip`,
  `https://npmmirror.com/mirrors/electron/${version}/${slug}.zip`,
  `https://github.com/electron/electron/releases/download/v${version}/${slug}.zip`,
];

function download(url, dest, depth = 0) {
  if (depth > 6) return Promise.reject(new Error(`too many redirects for ${url}`));
  return new Promise((resolve, reject) => {
    const request = get(url, { headers: { 'user-agent': 'dsh-desktop-build' } }, (response) => {
      const { statusCode, headers } = response;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        response.resume();
        resolve(download(new URL(headers.location, url).href, dest, depth + 1));
        return;
      }
      if (statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${statusCode}`));
        return;
      }
      const total = Number(headers['content-length'] ?? 0);
      let seen = 0;
      let nextMark = 0;
      response.on('data', (chunk) => {
        seen += chunk.length;
        if (total > 0 && seen >= nextMark) {
          const pct = Math.floor((seen / total) * 100);
          process.stdout.write(`\r  ${pct}% of ${(total / 1048576).toFixed(1)} MB`);
          nextMark = seen + total / 20;
        }
      });
      const out = createWriteStream(dest);
      response.pipe(out);
      out.on('finish', () => out.close(() => resolve(dest)));
      out.on('error', reject);
    });
    request.on('error', reject);
    request.setTimeout(900000, () => request.destroy(new Error('download timed out')));
  });
}

// ── 1. have the archive? ─────────────────────────────────────────────────────

mkdirSync(cacheDir, { recursive: true });
const plausible = existsSync(zipPath) && statSync(zipPath).size > 50 * 1048576;

if (!plausible) {
  rmSync(zipPath, { force: true });
  let lastError;
  for (const mirror of MIRRORS) {
    try {
      process.stdout.write(`fetching ${mirror}\n`);
      await download(mirror, zipPath);
      process.stdout.write('\n');
      lastError = undefined;
      break;
    } catch (error) {
      process.stdout.write(`\n  failed: ${error.message}\n`);
      lastError = error;
    }
  }
  if (lastError !== undefined) throw new Error(`all mirrors failed: ${lastError.message}`);
} else {
  process.stdout.write(`reusing cached ${zipPath}\n`);
}

process.stdout.write(`archive ${(statSync(zipPath).size / 1048576).toFixed(1)} MB\n`);

// ── 2. unpack ────────────────────────────────────────────────────────────────

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });
const extractModule = require('@electron-internal/extract-zip');
const extract = typeof extractModule === 'function' ? extractModule : extractModule.default;
if (typeof extract !== 'function') {
  throw new Error('@electron-internal/extract-zip did not export a function');
}
await extract(zipPath, { dir: distDir });
writeFileSync(path.join(electronDir, 'path.txt'), 'electron.exe', 'utf8');

const exe = path.join(distDir, 'electron.exe');
if (!existsSync(exe)) throw new Error(`unpack did not produce ${exe}`);
process.stdout.write(`ready: ${exe}\n`);
