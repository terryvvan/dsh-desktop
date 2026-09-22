'use strict';

/**
 * The update progress window.
 *
 * Before this existed an install had no feedback whatsoever: npm ran with
 * `--loglevel=error`, its output was buffered until the process exited, and the
 * only sign of life was an indeterminate taskbar bar. This window is the missing
 * feedback path — real bytes, real speed, a phase timeline, the installer's own
 * log, and controls that do something (pause, cancel, retry from the cache,
 * switch mirror).
 *
 * It is a separate `BrowserWindow` with its own preload, exactly like the
 * background settings window, so the DSH page never gains a route to these IPC
 * handlers.
 *
 * Closing the window does not cancel the install: the work continues in the main
 * process and 文件 → 更新进度… brings the window back.
 *
 * @module desktop/update-window
 */

const path = require('node:path');
const { BrowserWindow, ipcMain } = require('electron');

const WINDOW_WIDTH = 560;
const WINDOW_HEIGHT = 620;
/** Log lines kept for the window (and replayed when it reopens). */
const LOG_TAIL = 500;
/** Progress events arrive at ~4/s; the window does not need more than that. */
const BROADCAST_INTERVAL_MS = 150;

/** The install phases, in order, with the labels the timeline shows. */
const STEPS = [
  { phase: 'resolve', label: '解析依赖树' },
  { phase: 'plan', label: '探测下载体积' },
  { phase: 'download', label: '下载 tarball' },
  { phase: 'seed', label: '写入 npm 缓存' },
  { phase: 'install', label: '离线安装' },
  { phase: 'verify', label: '校验安装结果' },
  { phase: 'activate', label: '切换到新版本' },
];

/**
 * @param {object} options
 * @param {() => (import('electron').BrowserWindow | null)} options.getMainWindow
 * @param {(message: string) => void} options.log
 * @param {object} options.handlers  pause/resume/cancel/retry/restart/mirror/speedtest/openLog/close
 */
function createUpdateWindow({ getMainWindow, log, handlers = {} }) {
  let win = null;
  let ipcInstalled = false;
  let state = blankState();
  let lastBroadcast = 0;
  let broadcastTimer = null;

  function blankState() {
    return {
      version: null,
      channel: null,
      registryId: null,
      registry: null,
      mirrors: [],
      phase: null,
      phaseLabel: null,
      files: 0,
      totalFiles: 0,
      bytes: 0,
      totalBytes: 0,
      partial: 0,
      percent: null,
      speed: null,
      etaSeconds: null,
      elapsedSeconds: 0,
      current: null,
      failed: 0,
      paused: false,
      busy: false,
      error: null,
      finished: false,
      ready: false,
      cancelled: false,
      speedTest: null,
      steps: STEPS.map((step) => ({ ...step, status: 'pending', startedAt: null, endedAt: null })),
      log: [],
    };
  }

  /** What the renderer gets; `log` is sent separately, but a reopen needs it. */
  function snapshot() {
    return { ...state, log: state.log.slice(-LOG_TAIL) };
  }

  function send(channel, payload) {
    if (win === null || win.isDestroyed()) return;
    win.webContents.send(channel, payload);
  }

  function broadcast(force = false) {
    const now = Date.now();
    if (!force && now - lastBroadcast < BROADCAST_INTERVAL_MS) {
      if (broadcastTimer === null) {
        broadcastTimer = setTimeout(() => {
          broadcastTimer = null;
          broadcast(true);
        }, BROADCAST_INTERVAL_MS);
      }
      return;
    }
    lastBroadcast = now;
    send('dshup:state', snapshot());
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  function installIpc() {
    if (ipcInstalled) return;
    ipcInstalled = true;

    ipcMain.handle('dshup:get', () => snapshot());
    ipcMain.handle('dshup:action', async (_event, request) => {
      const type = typeof request?.type === 'string' ? request.type : '';
      const handler = handlers[type];
      if (typeof handler === 'function') {
        try {
          await handler(request?.payload ?? null);
        } catch (error) {
          log(`update: action ${type} failed: ${error.message}`);
        }
      } else {
        log(`update: unknown action: ${type}`);
      }
      broadcast(true);
      return snapshot();
    });
  }

  /** Open the window, or focus the one already open. */
  function open(info = {}) {
    installIpc();
    if (info.reset === true) {
      const mirrors = state.mirrors;
      state = blankState();
      state.mirrors = mirrors;
    }
    for (const key of ['version', 'channel', 'registryId', 'registry', 'mirrors']) {
      if (info[key] !== undefined) state[key] = info[key];
    }
    if (win !== null && !win.isDestroyed()) {
      broadcast(true);
      win.show();
      win.focus();
      return;
    }

    const main = getMainWindow();
    const parent = main !== null && main !== undefined && !main.isDestroyed() ? main : undefined;
    win = new BrowserWindow({
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      center: true,
      parent,
      // Deliberately not modal: an install can take minutes, and the window is
      // minimisable so the user can carry on working. The main window keeps its
      // own 「更新进度…」 menu entry to get back here.
      modal: false,
      resizable: false,
      minimizable: true,
      maximizable: false,
      fullscreenable: false,
      title: 'DSH 更新',
      backgroundColor: '#1b1c1f',
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        preload: path.join(__dirname, 'update-preload.js'),
      },
    });
    win.loadFile(path.join(__dirname, 'update.html'));
    win.once('ready-to-show', () => win?.show());
    win.on('closed', () => {
      win = null;
      clearTimeout(broadcastTimer);
      broadcastTimer = null;
      // The install is not cancelled here on purpose; see the module comment.
      handlers.closed?.();
      const owner = getMainWindow();
      if (owner === null || owner === undefined || owner.isDestroyed() || owner.isMinimized()) return;
      owner.moveTop();
      owner.focus();
    });
  }

  function close() {
    if (win !== null && !win.isDestroyed()) win.close();
  }

  function destroy() {
    clearTimeout(broadcastTimer);
    broadcastTimer = null;
    if (win !== null && !win.isDestroyed()) win.destroy();
    win = null;
  }

  // ── state updates ──────────────────────────────────────────────────────────

  /** Start a fresh run's bookkeeping (the caller may keep the window open). */
  function begin(info = {}) {
    const mirrors = state.mirrors;
    state = blankState();
    state.mirrors = mirrors;
    state.busy = true;
    for (const key of ['version', 'channel', 'registryId', 'registry', 'mirrors']) {
      if (info[key] !== undefined) state[key] = info[key];
    }
    appendLog(`开始更新到 ${info.version ?? '未知版本'}`);
    broadcast(true);
  }

  function appendLog(line) {
    const text = String(line);
    state.log.push(text);
    if (state.log.length > LOG_TAIL) state.log.splice(0, state.log.length - LOG_TAIL);
    send('dshup:log', text);
  }

  function markStep(phase, status) {
    const step = state.steps.find((entry) => entry.phase === phase);
    if (step === undefined) return;
    if (status === 'active' && step.startedAt === null) step.startedAt = Date.now();
    if (status === 'done' || status === 'error') step.endedAt = Date.now();
    step.status = status;
    // Everything before the active phase that never reported is done: npm does
    // not emit a per-phase callback for the transitions we infer here.
    if (status === 'active') {
      for (const entry of state.steps) {
        if (entry.phase === phase) break;
        if (entry.status === 'pending' || entry.status === 'active') {
          if (entry.startedAt === null) entry.startedAt = Date.now();
          entry.endedAt = entry.endedAt ?? Date.now();
          entry.status = 'done';
        }
      }
    }
  }

  function progress(event) {
    if (event === null || typeof event !== 'object') return;
    const phase = typeof event.phase === 'string' ? event.phase : null;
    if (phase !== null && phase !== state.phase) {
      state.phase = phase;
      const known = STEPS.find((step) => step.phase === phase);
      state.phaseLabel = known === undefined ? phase : known.label;
      markStep(phase, 'active');
      broadcast(true);
    }
    if (event.paused !== undefined) state.paused = event.paused === true;
    if (event.version !== undefined) state.version = event.version;
    if (event.error !== undefined) state.error = event.error;

    const download = phase === 'download' || event.files !== undefined || event.totalFiles !== undefined;
    if (download) {
      if (event.files !== undefined) state.files = event.files;
      if (event.totalFiles !== undefined) state.totalFiles = event.totalFiles;
      if (event.bytes !== undefined) state.bytes = event.bytes;
      if (event.totalBytes !== undefined) state.totalBytes = event.totalBytes;
      if (event.partial !== undefined) state.partial = event.partial;
      if (event.percent !== undefined) state.percent = event.percent;
      if (event.speed !== undefined) state.speed = event.speed;
      if (event.etaSeconds !== undefined) state.etaSeconds = event.etaSeconds;
      if (event.elapsedSeconds !== undefined) state.elapsedSeconds = event.elapsedSeconds;
      if (event.current !== undefined) state.current = event.current;
      if (event.failed !== undefined) state.failed = event.failed;
    }
    if (phase === 'seed') {
      if (event.done !== undefined) state.files = event.done;
      if (event.total !== undefined) state.totalFiles = event.total;
    }
    if (phase === 'plan') {
      if (event.planned !== undefined) state.files = event.planned;
      if (event.total !== undefined) state.totalFiles = event.total;
      if (event.totalBytes !== undefined) state.totalBytes = event.totalBytes;
    }
    broadcast();
  }

  function finish() {
    state.busy = false;
    state.finished = true;
    state.paused = false;
    state.ready = true;
    state.phase = 'ready';
    state.phaseLabel = '更新已就绪';
    for (const step of state.steps) {
      if (step.status === 'pending' || step.status === 'active') {
        step.status = 'done';
        step.endedAt = step.endedAt ?? Date.now();
      }
    }
    broadcast(true);
  }

  function fail(message) {
    state.busy = false;
    state.finished = true;
    state.ready = false;
    state.error = String(message);
    state.phase = 'error';
    state.phaseLabel = '更新失败';
    const active = state.steps.find((step) => step.status === 'active' || step.status === 'pending');
    if (active !== undefined) {
      active.status = 'error';
      active.endedAt = Date.now();
    }
    broadcast(true);
  }

  function markCancelled(message = '已取消；已下载的内容会保留，重试可续传') {
    state.busy = false;
    state.finished = true;
    state.ready = false;
    state.cancelled = true;
    state.error = null;
    state.phase = 'cancelled';
    state.phaseLabel = message;
    const active = state.steps.find((step) => step.status === 'active' || step.status === 'pending');
    if (active !== undefined) active.status = 'pending';
    broadcast(true);
  }

  /** Patch arbitrary state (mirror list, current mirror, speed-test results). */
  function patch(changes) {
    Object.assign(state, changes);
    broadcast(true);
  }

  return {
    open,
    close,
    destroy,
    begin,
    progress,
    appendLog,
    finish,
    fail,
    markCancelled,
    patch,
    snapshot,
    isOpen: () => win !== null && !win.isDestroyed(),
    isBusy: () => state.busy === true,
  };
}

module.exports = { createUpdateWindow, STEPS };
