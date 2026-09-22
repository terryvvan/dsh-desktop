'use strict';

/**
 * Tarball downloader for runtime updates.
 *
 * The update flow uses this instead of letting npm fetch the tree itself, for
 * three reasons npm cannot offer:
 *
 *   1. **Real progress.** npm's own progress is a TTY bar we would have to parse;
 *      here every byte is counted, so the UI can show size, speed and ETA.
 *   2. **Pause and resume.** A `.part` file survives a pause, an app restart or a
 *      mirror switch, and the next request continues from its offset with a
 *      `Range` header. npm has no equivalent (no SIGSTOP on Windows).
 *   3. **Mirror failover.** Every entry is retried against the other configured
 *      registries before the update is declared failed.
 *
 * What it hands npm is a full content-addressed cache (see `seedCache`), so the
 * final install runs offline and cannot fail halfway through on the network.
 *
 * Nothing here knows about DSH: it downloads `{name, version, url, integrity}`
 * records and returns the file it wrote.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

const DEFAULT_CONCURRENCY = 6;
/**
 * Sizing probes are one tiny ranged GET each, so they can run much wider than
 * the downloads: a full DSH tree is ~520 tarballs, and at the download width
 * that phase alone kept the window on "探测下载体积" for over half a minute.
 */
const PLAN_CONCURRENCY = 16;
/** Attempts per entry, walking the mirror list before giving up. */
const MAX_ATTEMPTS = 3;
/** How often aggregated progress is reported while bytes are flowing. */
const REPORT_INTERVAL_MS = 250;
/** Time allowed to reach the first byte of a tarball. */
const FIRST_BYTE_TIMEOUT_MS = 30000;
/** Time allowed between two chunks of the same tarball. */
const IDLE_TIMEOUT_MS = 60000;
/** Window used to compute the reported speed. */
const SPEED_WINDOW_MS = 5000;
const USER_AGENT = 'dsh-desktop-update/1.0';

/** Thrown when the user cancels; callers treat it as "stop, do not report a failure". */
class UpdateCancelledError extends Error {
  constructor() {
    super('更新已取消');
    this.name = 'UpdateCancelledError';
    this.cancelled = true;
  }
}

/** Internal: one attempt was stopped because the user paused. */
class PausedError extends Error {
  constructor() {
    super('已暂停');
    this.name = 'PausedError';
    this.paused = true;
  }
}

/**
 * Pause/cancel gate shared by the downloader and the progress window.
 * Pausing aborts the in-flight requests, which is what makes the pause instant;
 * the bytes already on disk are what makes the resume cheap.
 */
function createUpdateController() {
  let paused = false;
  let cancelled = false;
  const listeners = new Set();
  const notify = () => {
    for (const listener of listeners) {
      try {
        listener({ paused, cancelled });
      } catch {
        /* a broken listener must not stop the update */
      }
    }
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  return {
    get paused() {
      return paused;
    },
    get cancelled() {
      return cancelled;
    },
    pause() {
      if (paused || cancelled) return false;
      paused = true;
      notify();
      return true;
    },
    resume() {
      if (!paused) return false;
      paused = false;
      notify();
      return true;
    },
    cancel() {
      if (cancelled) return false;
      cancelled = true;
      paused = false;
      notify();
      return true;
    },
    onPauseChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Blocks while paused; returns immediately when cancelled. */
    async waitWhilePaused() {
      while (paused && !cancelled) await sleep(150);
    },
    throwIfCancelled() {
      if (cancelled) throw new UpdateCancelledError();
    },
  };
}

// ─── integrity ───────────────────────────────────────────────────────────────

/** `sha512-<base64>` → `{ algorithm, digest }`, or null when unusable. */
function parseIntegrity(value) {
  if (typeof value !== 'string') return null;
  const match = /^(sha512|sha256|sha1)-([A-Za-z0-9+/=]+)$/.exec(value.trim());
  if (match === null) return null;
  return { algorithm: match[1], digest: match[2] };
}

/** Hash a file and return it in Subresource-Integrity form (`sha512-…`). */
function hashFile(file, algorithm) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(`${algorithm}-${hash.digest('base64')}`));
  });
}

async function verifyFile(file, integrity) {
  const parsed = parseIntegrity(integrity);
  // No published integrity (rare, but some private registries omit it): the
  // tarball still gets its size checked by npm during install.
  if (parsed === null) return true;
  const actual = await hashFile(file, parsed.algorithm);
  return actual === `${parsed.algorithm}-${parsed.digest}`;
}

// ─── urls ────────────────────────────────────────────────────────────────────

/**
 * Point a tarball URL at another registry host.
 *
 * All the mirrors in `MIRRORS` serve the npm path layout, so the path is kept
 * and only the origin — plus the registry's own path prefix, for the mirrors
 * that are mounted under one (Huawei) — is replaced.
 */
function rewriteTarballUrl(url, registry) {
  let target;
  let base;
  try {
    target = new URL(url);
    base = new URL(registry);
  } catch {
    return url;
  }
  const prefix = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  const pathname = prefix === '/' ? target.pathname : `${prefix.replace(/\/$/, '')}${target.pathname}`;
  target.protocol = base.protocol;
  target.host = base.host;
  target.pathname = pathname;
  return target.href;
}

/** `@scope/name@1.2.3` → `@scope__name-1.2.3.tgz`, safe on Windows. */
function fileNameFor(entry) {
  const name = String(entry.name).replace(/[/\\]/g, '__');
  return `${name}-${entry.version}.tgz`;
}

function parseContentRange(value) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/.exec(String(value ?? '').trim());
  if (match === null) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === '*' ? null : Number(match[3]),
  };
}

// ─── size planning ───────────────────────────────────────────────────────────

/**
 * Ask each mirror how big a tarball is, with a one-byte ranged GET (`HEAD` is
 * refused by some registries). Returns the size in bytes or null.
 */
async function probeSize(url, { timeoutMs = FIRST_BYTE_TIMEOUT_MS } = {}) {
  const attempt = async (method, headers) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { method, headers, signal: controller.signal });
      if (!response.ok && response.status !== 206) return null;
      const range = parseContentRange(response.headers.get('content-range'));
      if (range !== null && range.total !== null) return range.total;
      const length = Number(response.headers.get('content-length'));
      // A HEAD answers with the full size; a ranged GET answers with 1.
      if (method === 'HEAD' && Number.isFinite(length) && length > 0) return length;
      return null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  return (await attempt('GET', { Range: 'bytes=0-0', 'user-agent': USER_AGENT })) ?? (await attempt('HEAD', {}));
}

/**
 * Fill in `entry.size` for every entry so the download can report real
 * percentages, and remember each entry's Content-Length per URL.
 */
async function planSizes(entries, { concurrency = PLAN_CONCURRENCY, onProgress = () => {}, controller, log } = {}) {
  let index = 0;
  let planned = 0;
  let totalBytes = 0;
  let unknown = 0;
  const worker = async () => {
    while (index < entries.length) {
      if (controller?.cancelled === true) throw new UpdateCancelledError();
      await controller?.waitWhilePaused();
      const entry = entries[index];
      index += 1;
      const size = await probeSize(entry.url);
      if (size === null) {
        unknown += 1;
        entry.size = null;
      } else {
        entry.size = size;
        totalBytes += size;
      }
      planned += 1;
      onProgress({ planned, total: entries.length, totalBytes, unknown });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, entries.length || 1)) }, worker));
  if (unknown > 0) log?.(`update: ${unknown}/${entries.length} 个包未公布体积，进度按已测量部分计算`);
  return { totalBytes, unknown, total: entries.length };
}

// ─── single entry ────────────────────────────────────────────────────────────

/**
 * Download one entry into `dir`, resuming from `<file>.part` when present.
 * @returns {Promise<{file: string, bytes: number, resumedFrom: number}>}
 */
async function downloadEntry(entry, { dir, controller, log, onBytes, fallbackUrls = [] }) {
  const file = path.join(dir, fileNameFor(entry));
  if (fs.existsSync(file)) {
    // Complete from an earlier run: keep it only if it still matches.
    if (await verifyFile(file, entry.integrity)) {
      onBytes(entry.size ?? fs.statSync(file).size, entry);
      return { file, bytes: fs.statSync(file).size, cached: true, resumedFrom: 0 };
    }
    fs.rmSync(file, { force: true });
  }
  const part = `${file}.part`;
  const urls = [entry.url, ...fallbackUrls].filter((value, position, all) => all.indexOf(value) === position);
  let lastError = new Error(`无法下载 ${entry.name}@${entry.version}`);
  let resumedFrom = 0;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    controller.throwIfCancelled();
    await controller.waitWhilePaused();
    const url = urls[Math.min(attempt, urls.length - 1)];
    const limit = controller.throwIfCancelled.bind(controller);
    try {
      const result = await fetchEntry({ entry, url, part, controller, onBytes });
      resumedFrom = result.resumedFrom;
      limit();
      if (!(await verifyFile(part, entry.integrity))) {
        fs.rmSync(part, { force: true });
        throw new Error('下载内容与 registry 公布的校验值不一致');
      }
      fs.rmSync(file, { force: true });
      fs.renameSync(part, file);
      log?.(`update: ${entry.name}@${entry.version} 下载完成（${formatBytes(result.bytes)}${result.resumedFrom > 0 ? `，续传自 ${formatBytes(result.resumedFrom)}` : ''}）`);
      return { file, bytes: result.bytes, cached: false, resumedFrom };
    } catch (error) {
      if (error instanceof UpdateCancelledError) throw error;
      if (error instanceof PausedError || controller.paused) {
        // Keep the .part file: the next attempt resumes from its length.
        lastError = new Error('已暂停');
        break;
      }
      lastError = error;
      log?.(`update: ${entry.name}@${entry.version} 第 ${attempt + 1} 次下载失败：${error.message}`);
    }
  }
  throw lastError;
}

/** One ranged GET, streamed to `part` (append when resuming). */
async function fetchEntry({ entry, url, part, controller, onBytes }) {
  let offset = 0;
  try {
    offset = fs.statSync(part).size;
  } catch {
    offset = 0;
  }
  const attemptController = new AbortController();
  const stop = () => attemptController.abort();
  const unsubscribe = controller.onPauseChange(({ paused, cancelled }) => {
    if (paused || cancelled) stop();
  });

  let idleTimer = null;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(stop, IDLE_TIMEOUT_MS);
  };
  let received = offset;
  armIdle();

  try {
    const headers = { 'user-agent': USER_AGENT, 'accept-encoding': 'identity' };
    if (offset > 0) headers.Range = `bytes=${offset}-`;
    const response = await fetch(url, { headers, signal: attemptController.signal });
    if (response.status === 416) {
      // The .part file is already as large as the server's copy: hash it and let
      // the caller decide whether it is complete.
      return { bytes: offset, resumedFrom: offset };
    }
    if (!response.ok && response.status !== 206) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    }
    let append = offset > 0 && response.status === 206;
    if (append) {
      const range = parseContentRange(response.headers.get('content-range'));
      if (range === null || range.start !== offset) {
        // The server answered a different range than we asked for: start over.
        append = false;
        offset = 0;
      }
    } else {
      offset = 0;
    }

    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        if (controller.cancelled) {
          callback(new UpdateCancelledError());
          return;
        }
        if (controller.paused) {
          callback(new PausedError());
          return;
        }
        received += chunk.length;
        armIdle();
        onBytes(chunk.length, entry);
        callback(null, chunk);
      },
    });

    await pipeline(
      Readable.fromWeb(response.body),
      counter,
      fs.createWriteStream(part, { flags: append ? 'a' : 'w' }),
    );
    if (controller.cancelled) throw new UpdateCancelledError();
    if (controller.paused) throw new PausedError();
    return { bytes: received, resumedFrom: offset };
  } catch (error) {
    if (controller.cancelled) throw new UpdateCancelledError();
    if (controller.paused || error instanceof PausedError) throw new PausedError();
    if (error.name === 'AbortError') throw new Error(`连接超时或中断（已下载 ${formatBytes(received)}）`);
    throw error;
  } finally {
    clearTimeout(idleTimer);
    unsubscribe();
  }
}

// ─── aggregate ───────────────────────────────────────────────────────────────

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 100 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--';
  const total = Math.round(seconds);
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes < 60) return `${minutes} 分 ${rest} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

/**
 * Download every entry, reporting aggregate progress.
 *
 * @param {Array<{name: string, version: string, url: string, integrity?: string, size?: number|null}>} entries
 * @param {object} options
 * @param {string} options.dir              where the tarballs (and .part files) live
 * @param {object} options.controller       from `createUpdateController()`
 * @param {string[]} [options.fallbackUrls] registry base URLs to try after `entry.url`
 * @param {number} [options.concurrency]
 * @param {(progress: object) => void} [options.onProgress]
 */
async function downloadAll(entries, options) {
  const {
    dir,
    // Callers that do not offer pause/cancel (the CLI updater test, any non-UI
    // path) get a controller that is simply never paused or cancelled.
    controller = createUpdateController(),
    log,
    fallbackUrls = [],
    concurrency = DEFAULT_CONCURRENCY,
    onProgress = () => {},
  } = options;

  fs.mkdirSync(dir, { recursive: true });
  const totalBytes = entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
  const startedAt = Date.now();
  const samples = [];
  let done = 0;
  let bytes = 0;
  let failed = 0;
  let current = null;
  let lastReport = 0;

  const snapshot = () => {
    const now = Date.now();
    const window = samples.filter((sample) => now - sample.at <= SPEED_WINDOW_MS);
    let speed = 0;
    if (window.length >= 2) {
      const first = window[0];
      const elapsed = (now - first.at) / 1000;
      if (elapsed > 0.2) speed = (bytes - first.bytes) / elapsed;
    }
    const remaining = Math.max(0, totalBytes - bytes);
    const partial = entries.some((entry) => entry.size === null);
    return {
      phase: 'download',
      files: done,
      totalFiles: entries.length,
      bytes,
      totalBytes,
      // With unmeasured tarballs the total is a lower bound; say so rather than
      // showing a percentage that can walk backwards.
      partial,
      percent: totalBytes > 0 ? Math.min(100, Math.round((bytes / totalBytes) * 100)) : 0,
      speed,
      etaSeconds: speed > 0 ? remaining / speed : null,
      elapsedSeconds: (now - startedAt) / 1000,
      current,
      failed,
      paused: controller.paused,
    };
  };

  const emit = (force = false) => {
    const now = Date.now();
    if (!force && now - lastReport < REPORT_INTERVAL_MS) return;
    lastReport = now;
    samples.push({ at: now, bytes });
    while (samples.length > 40) samples.shift();
    onProgress(snapshot());
  };

  const onBytes = (delta, entry) => {
    bytes += delta;
    current = `${entry.name}@${entry.version}`;
    emit(false);
  };

  const index = { value: 0 };
  const worker = async () => {
    while (index.value < entries.length) {
      controller.throwIfCancelled();
      await controller.waitWhilePaused();
      if (index.value >= entries.length) return;
      const entry = entries[index.value];
      index.value += 1;

      // Retry *this* entry while the user keeps it paused. The shared cursor is
      // never moved backwards, so two workers can never write the same `.part`.
      for (;;) {
        try {
          await downloadEntry(entry, {
            dir,
            controller,
            log,
            onBytes,
            fallbackUrls: fallbackUrlsFor(entry, fallbackUrls),
          });
          break;
        } catch (error) {
          if (error instanceof UpdateCancelledError) throw error;
          if (controller.paused) {
            await controller.waitWhilePaused();
            if (controller.cancelled) throw new UpdateCancelledError();
            continue;
          }
          failed += 1;
          emit(true);
          throw error;
        }
      }

      done += 1;
      current = `${entry.name}@${entry.version}`;
      emit(true);
    }
  };

  emit(true);
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, entries.length || 1)) }, () => worker()),
  );
  emit(true);
  return { files: done, bytes, seconds: (Date.now() - startedAt) / 1000 };
}

/** The other mirrors, expressed as tarball URLs for this entry. */
function fallbackUrlsFor(entry, bases) {
  const urls = [];
  for (const base of bases) {
    const url = rewriteTarballUrl(entry.url, base);
    if (url !== entry.url && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

module.exports = {
  createUpdateController,
  downloadAll,
  planSizes,
  probeSize,
  parseIntegrity,
  parseContentRange,
  verifyFile,
  rewriteTarballUrl,
  fileNameFor,
  formatBytes,
  formatDuration,
  UpdateCancelledError,
};
