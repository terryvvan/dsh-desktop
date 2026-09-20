'use strict';

/**
 * DeepSeek Harness — Windows desktop shell.
 *
 * The shell does not reimplement any DSH behaviour. It boots a DSH runtime as a
 * private child process (`dsh web --port 0 --no-open`), waits for the URL line
 * the runtime prints once its HTTP/WebSocket gateway is listening, and points a
 * BrowserWindow at that authenticated URL. The OS-assigned port means the
 * desktop app never collides with a `dsh web` the user already has running in a
 * terminal.
 *
 * Which runtime gets booted is decided by electron/updater.js: a copy shipped
 * inside the app, or a newer one installed into the user data directory. The
 * interpreter itself always comes from the app bundle.
 */

const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const { spawn, execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { createRuntimeManager } = require('./updater');
const { createBackgroundManager } = require('./background');

const APP_ID = 'ai.deepseek.harness.desktop';
const APP_TITLE = 'DeepSeek Harness';
const BOOT_TIMEOUT_MS = 180000;
/** `dsh web: http://127.0.0.1:PORT/?<token> (LAN: ...)` — printed by dsh-web-app. */
const URL_LINE = /dsh web:\s+(https?:\/\/\S+)/;

// ─── paths ───────────────────────────────────────────────────────────────────

/** Dev: the project dir. Packaged: <app>/resources, where extraResources landed. */
const bundleRoot = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');

const logDir = path.join(app.getPath('userData'), 'logs');
const logFile = path.join(logDir, 'desktop.log');
const stateFile = path.join(app.getPath('userData'), 'window-state.json');

// ─── state ───────────────────────────────────────────────────────────────────

/** @type {import('node:child_process').ChildProcess | null} */
let runtime = null;
/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {BrowserWindow | null} */
let splashWindow = null;
/** Authenticated URL of the running runtime, reused by "open in browser". */
let appUrl = null;
let bootTimer = null;
let quitting = false;
let restarting = false;
let installing = false;
let startupCheckStarted = false;
const exitWaiters = [];

// ─── logging ─────────────────────────────────────────────────────────────────

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(logFile, line, 'utf8');
  } catch {
    /* logging must never break startup */
  }
  process.stdout.write(line);
}

const runtimeManager = createRuntimeManager({
  bundledRuntimeDir: path.join(bundleRoot, 'runtime'),
  userDataDir: app.getPath('userData'),
  log,
});

const backgroundManager = createBackgroundManager({
  userDataDir: app.getPath('userData'),
  log,
  getMainWindow: () => mainWindow,
  // The palette and the window's own base colour are part of the background,
  // so both follow every persisted change.
  onChange: () => {
    backgroundManager.applyEnvironment();
    buildMenu();
  },
});

// Privileged schemes have to be declared before the app is ready, which is why
// this cannot wait for the manager to be installed below.
backgroundManager.registerScheme();

// ─── window state ────────────────────────────────────────────────────────────

function loadWindowState() {
  const fallback = { width: 1440, height: 920 };
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (!Number.isFinite(parsed.width) || !Number.isFinite(parsed.height)) return fallback;
    return parsed;
  } catch {
    return fallback;
  }
}

function saveWindowState(win) {
  if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
  try {
    const bounds = win.getNormalBounds();
    fs.writeFileSync(stateFile, JSON.stringify(bounds), 'utf8');
  } catch {
    /* best effort */
  }
}

// ─── DSH home ────────────────────────────────────────────────────────────────

/**
 * The desktop app deliberately shares the ordinary DSH home so existing
 * sessions, skills, and stored model credentials carry over. Set
 * DSH_DESKTOP_HOME to isolate the desktop shell instead.
 */
function dshHome() {
  return process.env.DSH_DESKTOP_HOME || process.env.DSH_HOME || path.join(app.getPath('home'), '.dsh');
}

// ─── runtime process ─────────────────────────────────────────────────────────

/** Strip Electron's own process-shaping vars; the child is plain node.exe. */
function childEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('ELECTRON_')) delete env[key];
  }
  delete env.NODE_OPTIONS;
  // dsh reads DSH_HOME; make the resolved value explicit so the child and the
  // shell's "open config folder" menu item can never disagree.
  env.DSH_HOME = dshHome();
  return env;
}

function preflight() {
  const active = runtimeManager.resolve();
  const problems = [];
  if (!fs.existsSync(runtimeManager.paths.nodeExe)) {
    problems.push(`缺少内置解释器：${runtimeManager.paths.nodeExe}`);
  }
  if (active.dshBin === null || !fs.existsSync(active.dshBin)) {
    problems.push(`缺少 DSH 入口：${active.dshBin ?? '(无法解析)'}`);
  }
  if (problems.length === 0) return true;
  dialog.showErrorBox(
    `${APP_TITLE} — 运行时缺失`,
    `${problems.join('\n')}\n\n请在项目目录执行 npm run prepare:runtime 重新生成 runtime/，然后重新构建。`,
  );
  return false;
}

function startRuntime() {
  appUrl = null;
  const active = runtimeManager.resolve();
  if (active.dshBin === null || !fs.existsSync(active.dshBin)) {
    failBoot(`找不到可用的 DSH 运行时入口：${active.dshBin ?? '(无法解析)'}`);
    return;
  }

  log(`booting DSH ${active.version ?? '未知版本'} (${active.source === 'bundled' ? '内置' : '已安装'})`);
  log(`spawning runtime: ${runtimeManager.paths.nodeExe} ${active.dshBin} web --port 0 --no-open`);
  log(`DSH_HOME=${dshHome()}`);

  runtime = spawn(
    runtimeManager.paths.nodeExe,
    [active.dshBin, 'web', '--port', '0', '--no-open'],
    {
      cwd: app.getPath('home'),
      env: childEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let pending = '';
  runtime.stdout.setEncoding('utf8');
  runtime.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    pending += chunk;
    let index;
    while ((index = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      onRuntimeLine(line);
    }
    if (pending.length > 8192) pending = pending.slice(-8192);
  });

  runtime.stderr.setEncoding('utf8');
  runtime.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
    try {
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(logFile, chunk, 'utf8');
    } catch {
      /* best effort */
    }
  });

  runtime.on('error', (error) => {
    // A failure to spawn is an environment problem, not a bad runtime version,
    // so it must not trigger a rollback.
    log(`runtime spawn error: ${error.message}`);
    clearBootTimer();
    failBoot(`无法启动内核进程：${error.message}`);
  });

  runtime.on('exit', (code, signal) => {
    log(`runtime exited code=${code} signal=${signal}`);
    runtime = null;
    for (const waiter of exitWaiters.splice(0)) waiter();
    if (quitting || restarting) return;
    if (appUrl === null) {
      handleBootFailure(`内核在报告监听地址之前就退出了（退出码 ${code ?? 'null'}）。`);
      return;
    }
    appUrl = null;
    buildMenu();
    dialog
      .showMessageBox(mainWindow ?? undefined, {
        type: 'error',
        title: APP_TITLE,
        message: 'DSH 内核进程已退出',
        detail: `退出码 ${code ?? 'null'}。日志：${logFile}`,
        buttons: ['重启内核', '退出'],
        defaultId: 0,
        cancelId: 1,
      })
      .then((result) => {
        if (result.response === 0) void restartRuntime();
        else app.quit();
      });
  });

  bootTimer = setTimeout(() => {
    bootTimer = null;
    handleBootFailure(
      `内核在 ${BOOT_TIMEOUT_MS / 1000} 秒内没有报告监听地址（通常意味着某个插件加载失败）。`,
    );
  }, BOOT_TIMEOUT_MS);
}

function clearBootTimer() {
  clearTimeout(bootTimer);
  bootTimer = null;
}

function onRuntimeLine(line) {
  const trimmed = line.trim();
  if (trimmed !== '') console.log(trimmed);
  const match = URL_LINE.exec(trimmed);
  if (match === null || appUrl !== null) return;
  appUrl = match[1];
  clearBootTimer();
  runtimeManager.noteBootSuccess();
  log(`runtime ready at ${appUrl}`);
  // The menu was built before the runtime had an address, so refresh the
  // entries that depend on it.
  buildMenu();
  showMainWindow(appUrl);
}

/**
 * A runtime that cannot start may simply be a bad release. Two consecutive
 * failures on an installed version drop back to the previous one (or to the
 * bundled copy) before the user is told anything went wrong, which is what
 * makes updating safe.
 */
function handleBootFailure(detail) {
  clearBootTimer();
  const outcome = runtimeManager.recordBootFailure(detail);
  if (!outcome.rolledBack) {
    failBoot(detail);
    return;
  }
  const target = outcome.source === 'bundled' ? '内置运行时' : `上一个版本 ${outcome.to}`;
  log(`boot failure on ${outcome.from}; rolled back to ${target}`);
  dialog.showMessageBoxSync({
    type: 'warning',
    title: `${APP_TITLE} — 已回退运行时`,
    message: `DSH ${outcome.from} 启动失败，已回退到 ${target}`,
    detail: `${detail}\n\n将用回退后的运行时重启内核。运行日志：${logFile}`,
    buttons: ['继续'],
  });
  void restartRuntime();
}

/** Kill the runtime and its whole process tree (dsh spawns shells/subagents). */
function stopRuntime() {
  clearBootTimer();
  return new Promise((resolve) => {
    const child = runtime;
    if (child === null || child.pid === undefined || child.exitCode !== null) {
      resolve();
      return;
    }
    exitWaiters.push(resolve);
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, (error) => {
      if (error) log(`taskkill failed: ${error.message}`);
      resolve();
    });
  });
}

async function restartRuntime() {
  restarting = true;
  const previous = appUrl;
  appUrl = null;
  await stopRuntime();
  restarting = false;
  if (quitting) return;
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(makeLoadingPage('正在重启 DSH 内核…'));
  } else if (previous !== null) {
    showSplash();
  }
  startRuntime();
}

// ─── windows ─────────────────────────────────────────────────────────────────

function makeLoadingPage(message) {
  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:#1b1c1f;color:#e8e8ea;
      font:14px/1.6 "Segoe UI","Microsoft YaHei",system-ui,sans-serif;
      display:flex;align-items:center;justify-content:center}
    .box{text-align:center;opacity:.85}
    .spin{width:26px;height:26px;margin:0 auto 14px;border-radius:50%;
      border:2px solid #3a3d44;border-top-color:#4d6bfe;animation:r .9s linear infinite}
    @keyframes r{to{transform:rotate(360deg)}}
  </style><div class="box"><div class="spin"></div>${message}</div>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function showSplash() {
  if (splashWindow !== null && !splashWindow.isDestroyed()) return;
  splashWindow = new BrowserWindow({
    width: 460,
    height: 280,
    frame: false,
    resizable: false,
    center: true,
    show: false,
    backgroundColor: '#1b1c1f',
    skipTaskbar: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  splashWindow.once('ready-to-show', () => splashWindow?.show());
  splashWindow.on('closed', () => {
    splashWindow = null;
  });
}

function closeSplash() {
  if (splashWindow !== null && !splashWindow.isDestroyed()) splashWindow.close();
  splashWindow = null;
}

function showMainWindow(url) {
  const state = loadWindowState();
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(url);
    mainWindow.show();
    mainWindow.focus();
    closeSplash();
    return;
  }

  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: APP_TITLE,
    // The wallpaper's own mean colour while configured, so the first paint
    // blends into the image instead of flashing the shell's dark chrome.
    backgroundColor: backgroundManager.windowBackground(),
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    closeSplash();
    mainWindow?.show();
    mainWindow?.focus();
    maybeAutoCheck();
  });

  // The shell only ever hosts the local runtime; anything else goes to the OS.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isLocalUrl(target)) return { action: 'allow' };
    shell.openExternal(target).catch((error) => log(`openExternal failed: ${error.message}`));
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (isLocalUrl(target)) return;
    event.preventDefault();
    shell.openExternal(target).catch((error) => log(`openExternal failed: ${error.message}`));
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log(`renderer gone: ${details.reason}`);
  });

  mainWindow.on('close', () => saveWindowState(mainWindow));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  backgroundManager.attachWindow(mainWindow);
  mainWindow.loadURL(url);
}

function isLocalUrl(target) {
  try {
    const { hostname, protocol } = new URL(target);
    if (protocol === 'data:' || protocol === 'file:') return true;
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}

function failBoot(detail) {
  log(`boot failure: ${detail}`);
  clearBootTimer();
  closeSplash();
  const choice = dialog.showMessageBoxSync({
    type: 'error',
    title: `${APP_TITLE} — 启动失败`,
    message: 'DSH 内核启动失败',
    detail,
    buttons: ['查看日志目录', '退出'],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice === 0) {
    shell.openPath(logDir).catch(() => {});
    app.quit();
  } else {
    app.quit();
  }
}

// ─── updates ─────────────────────────────────────────────────────────────────

function setTaskbarProgress(value) {
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    try {
      mainWindow.setProgressBar(value);
    } catch {
      /* not fatal */
    }
  }
}

/** Silent check once the UI is up; never opens a dialog on failure. */
function maybeAutoCheck() {
  if (startupCheckStarted) return;
  startupCheckStarted = true;
  const state = runtimeManager.readState();
  if (!state.autoCheck) return;
  setTimeout(() => {
    void runtimeManager
      .check({})
      .then((result) => {
        log(
          `update check: channel=${result.channel} current=${result.current} latest=${result.latest} available=${result.updateAvailable}`,
        );
        if (result.updateAvailable) promptInstall(result);
      })
      .catch((error) => log(`update check failed: ${error.message}`));
  }, 8000);
}

function promptInstall(result) {
  const choice = dialog.showMessageBoxSync(mainWindow ?? undefined, {
    type: 'info',
    title: `${APP_TITLE} — 发现新版本`,
    message: `DSH ${result.latest} 可用（当前 ${result.current}）`,
    detail:
      `更新通道：${result.channel}\n\n` +
      '更新会在后台下载并安装到当前用户目录，不需要重新安装应用，也不会打断正在进行的会话。' +
      '安装完成后重启内核即可生效；如果新版本启动失败，会自动回退。',
    buttons: ['下载并安装', '稍后', '忽略此版本'],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice === 0) void runInstall(result.latest);
  else if (choice === 2) runtimeManager.writeState({ skippedVersion: result.latest });
}

async function runInstall(version) {
  if (installing) return;
  installing = true;
  setTaskbarProgress(2); // indeterminate
  try {
    const result = await runtimeManager.install(version, {
      onProgress: ({ phase }) => log(`update: ${phase} ${version}`),
    });
    runtimeManager.prune();
    log(`update installed: ${version}${result.reused ? ' (already present)' : ''}`);
    setTaskbarProgress(-1);

    const activated = runtimeManager.readState().activeVersion === version;
    const choice = dialog.showMessageBoxSync(mainWindow ?? undefined, {
      type: 'info',
      title: `${APP_TITLE} — 更新已就绪`,
      message: `DSH ${version} 已安装`,
      detail: activated
        ? '重启内核后生效。正在运行的会话会被中断。'
        : `已安装到磁盘，但当前仍在使用 ${runtimeManager.describe().active}。`,
      buttons: activated ? ['立即重启内核', '稍后'] : ['好的'],
      defaultId: 0,
      cancelId: 1,
    });
    if (activated && choice === 0) void restartRuntime();
  } catch (error) {
    log(`update failed: ${error.message}`);
    setTaskbarProgress(-1);
    dialog.showErrorBox(
      `${APP_TITLE} — 更新失败`,
      `${error.message}\n\n当前仍在运行原有运行时，未做任何改动。\n日志：${logFile}`,
    );
  } finally {
    installing = false;
  }
}

async function manualCheck() {
  const item = Menu.getApplicationMenu()?.getMenuItemById('check-updates');
  if (item !== undefined) item.enabled = false;
  try {
    const result = await runtimeManager.check({});
    if (result.updateAvailable) {
      promptInstall(result);
      return;
    }
    const same = result.current === result.latest;
    dialog.showMessageBoxSync(mainWindow ?? undefined, {
      type: 'info',
      title: `${APP_TITLE} — 检查更新`,
      message: same ? `已是最新版本：DSH ${result.current}` : `当前已是最新`,
      detail:
        `当前运行：DSH ${result.current}（${describeSource()}）\n` +
        `更新通道：${result.channel} → ${result.latest}\n\n` +
        `可用通道：${Object.entries(result.tags)
          .map(([name, value]) => `${name}=${value}`)
          .join('\n')}`,
      buttons: ['好的'],
    });
  } catch (error) {
    dialog.showErrorBox(
      `${APP_TITLE} — 检查更新失败`,
      `${error.message}\n\n如果这台机器访问不到公共 registry，请在 ~/.npmrc 里配置可用的镜像后再试。`,
    );
  } finally {
    if (item !== undefined) item.enabled = true;
  }
}

function describeSource() {
  const described = runtimeManager.describe();
  return described.source === 'bundled' ? '内置运行时' : '已安装更新';
}

async function setChannel(channel) {
  runtimeManager.writeState({ channel, skippedVersion: null });
  log(`update channel set to ${channel}`);
  buildMenu();
  await manualCheck();
}

function doRollback() {
  const described = runtimeManager.describe();
  if (described.previous === null && described.source === 'bundled') return;
  const outcome = runtimeManager.rollback('用户从菜单手动回退');
  buildMenu();
  void dialog
    .showMessageBox(mainWindow ?? undefined, {
      type: 'info',
      title: `${APP_TITLE} — 已回退`,
      message: `已切换到 ${outcome.source === 'bundled' ? '内置运行时' : `DSH ${outcome.version}`}`,
      detail: '重启内核后生效。',
      buttons: ['立即重启内核', '稍后'],
      defaultId: 0,
      cancelId: 1,
    })
    .then((result) => {
      if (result.response === 0) void restartRuntime();
    });
}

// ─── menu ────────────────────────────────────────────────────────────────────

function buildMenu() {
  const described = runtimeManager.describe();
  const channelItems = runtimeManager.CHANNELS.map((name) => ({
    label: name === 'next' ? 'next（稳态预发布）' : name === 'alpha' ? 'alpha（跟随 master）' : 'latest',
    type: 'radio',
    checked: described.channel === name,
    click: () => void setChannel(name),
  }));

  const template = [
    {
      label: '文件(&F)',
      submenu: [
        {
          label: `当前 DSH ${described.active ?? '未知'} · ${described.source === 'bundled' ? '内置' : '已安装'}`,
          enabled: false,
        },
        { type: 'separator' },
        { label: '重新加载界面', accelerator: 'F5', click: () => mainWindow?.reload() },
        {
          label: '在默认浏览器中打开',
          id: 'open-in-browser',
          enabled: appUrl !== null,
          click: () => {
            if (appUrl !== null) shell.openExternal(appUrl).catch(() => {});
          },
        },
        {
          label: '重启 DSH 内核',
          click: () => {
            void restartRuntime();
          },
        },
        { type: 'separator' },
        { label: '检查更新…', id: 'check-updates', click: () => void manualCheck() },
        { label: '更新通道', submenu: channelItems },
        {
          label: described.previous === null ? '回退到上一版本' : `回退到 DSH ${described.previous}`,
          id: 'rollback',
          enabled: described.previous !== null,
          click: () => doRollback(),
        },
        {
          label: '恢复为内置运行时',
          id: 'use-bundled',
          enabled: described.source !== 'bundled',
          click: () => {
            runtimeManager.writeState({ activeVersion: null, previousVersion: null });
            buildMenu();
            void restartRuntime();
          },
        },
        { type: 'separator' },
        { label: `打开配置目录 (${dshHome()})`, click: () => shell.openPath(dshHome()).catch(() => {}) },
        { label: '打开日志目录', click: () => shell.openPath(logDir).catch(() => {}) },
        { type: 'separator' },
        { label: '退出', accelerator: 'Alt+F4', role: 'quit' },
      ],
    },
    {
      label: '编辑(&E)',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' },
      ],
    },
    {
      label: '视图(&V)',
      submenu: [
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' },
        {
          label: '开发者工具',
          accelerator: 'F12',
          click: () => mainWindow?.webContents.toggleDevTools(),
        },
        { type: 'separator' },
        { label: '背景设置…', click: () => backgroundManager.openSettings() },
        {
          label: '清除背景图片',
          id: 'clear-background',
          enabled: backgroundManager.hasBackground(),
          click: () => backgroundManager.clearBackground(),
        },
      ],
    },
    {
      label: '帮助(&H)',
      submenu: [
        {
          label: '关于 DeepSeek Harness',
          click: () => {
            const info = runtimeManager.describe();
            dialog.showMessageBox(mainWindow ?? undefined, {
              type: 'info',
              title: `关于 ${APP_TITLE}`,
              message: APP_TITLE,
              detail:
                `桌面外壳 ${app.getVersion()}（Electron ${process.versions.electron}）\n` +
                `当前 DSH ${info.active ?? '未知'}（${info.source === 'bundled' ? '内置运行时' : '已安装更新'}）\n` +
                `内置 DSH ${info.bundled ?? '未知'}\n` +
                `更新通道 ${info.channel}${info.previous === null ? '' : ` · 上一版本 ${info.previous}`}\n` +
                `已安装版本 ${info.installed.length === 0 ? '（无）' : info.installed.join(', ')}\n` +
                `上次检查 ${info.lastCheck ?? '从未'}\n\n` +
                `配置目录 ${dshHome()}\n` +
                `日志 ${logFile}`,
              buttons: ['好的'],
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─── app lifecycle ───────────────────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.setAppUserModelId(APP_ID);

  app.whenReady().then(() => {
    log(`--- ${APP_TITLE} shell ${app.getVersion()} starting ---`);
    runtimeManager.cleanStaging();
    backgroundManager.install();
    // A configured wallpaper decides the palette, and therefore what the
    // runtime's pages resolve `prefers-color-scheme` to, before they boot.
    backgroundManager.applyEnvironment();
    buildMenu();
    if (!preflight()) {
      app.quit();
      return;
    }
    showSplash();
    startRuntime();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    if (runtime !== null) {
      event.preventDefault();
      stopRuntime().then(() => app.quit());
    }
  });

  app.on('activate', () => {
    if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.show();
  });
}
