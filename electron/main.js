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
const { createDesktopMenu, buildMenuData, toTemplate } = require('./desktop-menu');
const { createProfileGuard } = require('./profile-guard');

const APP_ID = 'ai.deepseek.harness.desktop';
const APP_TITLE = 'DeepSeek Harness';
const BOOT_TIMEOUT_MS = 180000;
/** Grace period for a taskkilled kernel to actually be reaped before moving on. */
const STOP_TIMEOUT_MS = 10000;
/** `dsh web` is an alias for `--profile web`; that profile is what we guard. */
const WEB_PROFILE = 'web';
/** Kernel output lines kept for boot-failure attribution (boot phase only). */
const KERNEL_OUTPUT_LINES = 400;
/** `dsh web: http://127.0.0.1:PORT/?<token> (LAN: ...)` — printed by dsh-web-app. */
const URL_LINE = /dsh web:\s+(https?:\/\/\S+)/;

// ─── paths ───────────────────────────────────────────────────────────────────

/** Dev: the project dir. Packaged: <app>/resources, where extraResources landed. */
const bundleRoot = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');

const logDir = path.join(app.getPath('userData'), 'logs');
const logFile = path.join(logDir, 'desktop.log');
const stateFile = path.join(app.getPath('userData'), 'window-state.json');
/** Which menu bar the user chose: the page's own, or the system one. */
const menuStateFile = path.join(app.getPath('userData'), 'menu-state.json');

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
/**
 * Config recovery stages already tried for the current failure streak: 0 = none,
 * 1 = last-known-good config restored, 2 = safe mode. Reset by a successful boot
 * so a user who fixes their config by hand is never blocked by a spent budget.
 */
let configRecoveryStage = 0;
/** True once third-party bundles were disabled to get the app running again. */
let safeModeActive = false;
/**
 * Whether the menu bar is drawn inside the page (the default, so the background
 * runs behind it) or left to the system. The system menu is still registered
 * either way — it is what owns the accelerators — but its bar is hidden while
 * this is true. See `electron/desktop-menu.js`.
 */
let pageMenuBar = readMenuState();
/** The in-page menu bar, installed on the main window once it exists. */
let desktopMenu = null;
/** Boot-phase kernel output, used to name the plugin that broke the boot. */
const kernelOutput = [];
const exitWaiters = [];

// ─── menu bar preference ─────────────────────────────────────────────────────

/**
 * Which menu bar to draw. The in-page one is the default because the background
 * is painted by the page: a system menu bar is window chrome, and on Windows its
 * fill cannot be made transparent, so it would always be an opaque strip above
 * the wallpaper.
 * @returns {boolean} true to draw the menu inside the page.
 */
function readMenuState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(menuStateFile, 'utf8'));
    // Default to the page menu: an absent or unreadable file means "not chosen".
    return parsed.pageMenu !== false;
  } catch {
    return true;
  }
}

function writeMenuState() {
  try {
    fs.writeFileSync(menuStateFile, `${JSON.stringify({ pageMenu: pageMenuBar }, null, 2)}\n`, 'utf8');
  } catch (error) {
    log(`menu: failed to save the menu bar choice: ${error.message}`);
  }
}

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

/**
 * Remembers the profile config that last booted, so a plugin that breaks
 * startup can be rolled back automatically instead of leaving the user with an
 * app that will not open.
 */
const profileGuard = createProfileGuard({
  dshHome: dshHome(),
  userDataDir: app.getPath('userData'),
  profileName: WEB_PROFILE,
  log,
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

  // Keep our own handle on the child. Every event handler below re-checks it
  // against `runtime`, because a kernel we killed can still emit 'exit' after
  // its replacement has been spawned; such an event must never be attributed to
  // the new kernel or it would be reported as a boot failure.
  const child = spawn(
    runtimeManager.paths.nodeExe,
    [active.dshBin, 'web', '--port', '0', '--no-open'],
    {
      cwd: app.getPath('home'),
      env: childEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  runtime = child;
  kernelOutput.length = 0;

  let pending = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    pending += chunk;
    let index;
    while ((index = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      onRuntimeLine(line, child);
    }
    if (pending.length > 8192) pending = pending.slice(-8192);
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
    // Every line the kernel prints before its address is diagnostic gold: it is
    // the only place a failed plugin names itself. (stderr is already mirrored
    // into the log verbatim just below.)
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim() !== '') recordKernelOutput(line, false);
    }
    try {
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(logFile, chunk, 'utf8');
    } catch {
      /* best effort */
    }
  });

  child.on('error', (error) => {
    // A failure to spawn is an environment problem, not a bad runtime version,
    // so it must not trigger a rollback.
    log(`runtime spawn error: ${error.message}`);
    if (runtime !== child) return;
    clearBootTimer();
    failBoot(`无法启动内核进程：${error.message}`);
  });

  child.on('exit', (code, signal) => {
    if (runtime !== child) {
      log(`stale runtime exited code=${code} signal=${signal} (ignored)`);
      return;
    }
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

/**
 * Remember one boot-phase kernel line for failure attribution. Kernel stdout is
 * also mirrored into the log with a `kernel| ` marker, because desktop.log
 * otherwise only carries stderr and a failed boot's own words are exactly what
 * is needed to name the culprit later.
 */
function recordKernelOutput(line, mirror = true) {
  if (appUrl !== null) return;
  kernelOutput.push(line);
  if (kernelOutput.length > KERNEL_OUTPUT_LINES) kernelOutput.splice(0, kernelOutput.length - KERNEL_OUTPUT_LINES);
  if (!mirror) return;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(logFile, `kernel| ${line}\n`, 'utf8');
  } catch {
    /* best effort */
  }
}

function onRuntimeLine(line, child) {
  // Ignore anything a superseded kernel still manages to print on its way out.
  if (runtime !== child) return;
  const trimmed = line.trim();
  if (trimmed !== '') console.log(trimmed);
  const match = URL_LINE.exec(trimmed);
  if (match === null) {
    if (trimmed !== '') recordKernelOutput(trimmed);
    return;
  }
  if (appUrl !== null) return;
  appUrl = match[1];
  clearBootTimer();
  runtimeManager.noteBootSuccess();
  log(`runtime ready at ${appUrl}`);
  // This config just produced a working kernel, so it becomes the baseline the
  // next failed boot rolls back to. A recovery budget is spent for good once a
  // boot succeeds.
  configRecoveryStage = 0;
  snapshotGoodConfig();
  // The menu was built before the runtime had an address, so refresh the
  // entries that depend on it.
  buildMenu();
  showMainWindow(appUrl);
}

/** Snapshot the config behind a successful boot; never fatal to startup. */
function snapshotGoodConfig() {
  try {
    const outcome = profileGuard.snapshot({ keepExisting: safeModeActive });
    if (outcome.saved) log(`profile-guard: last-good config saved (${outcome.files.join(', ')})`);
  } catch (error) {
    log(`profile-guard: snapshot failed: ${error.message}`);
  }
}

/**
 * A kernel that cannot start has two very different suspects, and they need
 * opposite fixes, so they are tried in order of likelihood:
 *
 *   1. the profile config changed since the last boot that worked — put the
 *      known-good config back (this is the common case: a plugin was just
 *      added, enabled, or hand-edited);
 *   2. the runtime release itself is bad — the existing two-strikes version
 *      rollback, which now happens *before* touching plugins, so a broken
 *      release can never cost the user their plugin setup;
 *   3. nothing is left to fall back to (the immutable bundled runtime is already
 *      running) — drop third-party bundles so the app opens at all.
 *
 * Only then is the failure terminal.
 */
function handleBootFailure(detail) {
  clearBootTimer();
  if (configRecoveryStage < 1 && profileGuard.hasSnapshot() && recoverProfileConfig(detail, 'restore')) {
    return;
  }

  // A runtime that cannot start may simply be a bad release. Two consecutive
  // failures on an installed version drop back to the previous one (or to the
  // bundled copy) before the user is told anything went wrong, which is what
  // makes updating safe.
  const outcome = runtimeManager.recordBootFailure(detail);
  if (outcome.rolledBack) {
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
    return;
  }

  // Nothing left to roll back to: strip the third-party plugins rather than
  // leave the user with an app that will not open at all.
  if (
    !safeModeActive &&
    runtimeManager.describe().source === 'bundled' &&
    recoverProfileConfig(detail, 'safe-mode')
  ) {
    return;
  }

  failBoot(detail);
}

/**
 * Run one config-recovery stage. Returns true when the kernel is being
 * restarted on repaired config, i.e. when the caller must not treat this as a
 * terminal failure.
 *
 * @param mode - 'restore' puts the last known-good config back (a no-op when the
 *   config never changed), 'safe-mode' disables third-party bundles.
 */
function recoverProfileConfig(detail, mode) {
  const output = kernelOutput.join('\n');
  let outcome = null;
  try {
    outcome =
      mode === 'restore'
        ? profileGuard.restoreLastGood({ output, detail })
        : profileGuard.enterSafeMode({ output, detail });
  } catch (error) {
    log(`profile-guard: ${mode} recovery failed: ${error.message}`);
    return false;
  }
  if (!outcome.recovered) {
    log(`profile-guard: ${mode} recovery skipped (${outcome.reason})`);
    return false;
  }

  configRecoveryStage = Math.max(configRecoveryStage, mode === 'restore' ? 1 : 2);
  if (mode === 'safe-mode') safeModeActive = true;
  log(
    `profile-guard: ${outcome.mode} recovery restored ${outcome.restored.join(', ') || '(nothing)'}` +
      `${outcome.removed.length > 0 ? `, removed ${outcome.removed.join(', ')}` : ''}; ` +
      `suspected ${outcome.culprits.join(', ') || '(unknown)'}; backup ${outcome.backupDir}`,
  );
  notifyConfigRecovery(outcome, detail);
  void restartRuntime();
  return true;
}

/**
 * Kill the runtime and its whole process tree (dsh spawns shells/subagents).
 *
 * Resolves only once node has delivered the child's 'exit' event, i.e. once the
 * process is really gone. `taskkill` exiting tells us nothing: termination is
 * asynchronous, and its exit event can arrive after the caller has already
 * spawned the replacement kernel — which used to null out `runtime`, drop the
 * live kernel's handle, and raise a bogus "内核在报告监听地址之前就退出了" dialog.
 */
function stopRuntime() {
  clearBootTimer();
  const child = runtime;
  if (child === null || child.pid === undefined || child.exitCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = (late) => {
      if (late) log(`stop: kernel ${child.pid} was still alive after ${STOP_TIMEOUT_MS} ms, continuing anyway`);
      clearTimeout(timer);
      const index = exitWaiters.indexOf(waiter);
      if (index !== -1) exitWaiters.splice(index, 1);
      resolve();
    };
    const waiter = () => done(false);
    const timer = setTimeout(() => done(true), STOP_TIMEOUT_MS);
    exitWaiters.push(waiter);
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, (error) => {
      // Only used to kill; completion is signalled by the child's 'exit' event.
      if (error) log(`taskkill failed: ${error.message}`);
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

// ─── config recovery reporting ───────────────────────────────────────────────

/** One bullet per restored/removed file, relative to DSH_HOME. */
function describeConfigChanges(outcome) {
  const lines = [];
  for (const rel of outcome.restored) lines.push(`· 已恢复 ${rel}`);
  for (const rel of outcome.removed) lines.push(`· 已移除 ${rel}（新增的补丁层，已备份）`);
  for (const rel of outcome.kept ?? []) lines.push(`· 保留 ${rel}（缺失的锁文件不自动重建，如需请重新安装插件）`);
  return lines.join('\n');
}

/** "疑似元凶" block shared by the automatic and the manual recovery dialogs. */
function describeCulprits(outcome) {
  const lines = [];
  if (outcome.culprits !== undefined && outcome.culprits.length > 0) {
    lines.push(`疑似导致启动失败的插件：${outcome.culprits.join('、')}`);
  } else if (outcome.configFiles !== undefined && outcome.configFiles.length > 0) {
    lines.push(`失败原因是配置文件无法解析：${outcome.configFiles.join('、')}`);
  } else {
    lines.push('未能确定具体插件，已按整体配置回退。');
  }
  if (outcome.configFiles !== undefined && outcome.configFiles.length > 0 && outcome.culprits !== undefined && outcome.culprits.length > 0) {
    lines.push(`同时无法解析：${outcome.configFiles.join('、')}`);
  }
  if (outcome.disabled !== undefined && outcome.disabled.length > 0) {
    lines.push(`已停用第三方插件：${outcome.disabled.join('、')}`);
  }
  for (const line of outcome.evidence ?? []) lines.push(`内核报告：${line}`);
  return lines.join('\n');
}

/**
 * Tell the user what just happened while the repaired kernel boots. Async on
 * purpose: the restart must not wait for someone to click a button.
 */
function notifyConfigRecovery(outcome, detail) {
  const heading =
    outcome.mode === 'safe-mode'
      ? 'DSH 启动失败，已进入安全模式'
      : `DSH 启动失败，已回退到 ${new Date(outcome.savedAt).toLocaleString()} 的配置`;
  const lines = [
    `失败原因：${detail}`,
    '',
    describeCulprits(outcome),
    '',
    describeConfigChanges(outcome) || '· 配置未发生变化',
    '',
    `出错时的配置已备份到：${outcome.backupDir}`,
    '正在用回退后的配置重启内核。',
  ];
  log(`config recovery (${outcome.mode}): ${heading}`);
  dialog
    .showMessageBox(mainWindow ?? undefined, {
      type: 'warning',
      title: `${APP_TITLE} — 已自动回退配置`,
      message: heading,
      detail: lines.filter((line) => line !== undefined).join('\n'),
      buttons: ['好的', '打开备份目录'],
      defaultId: 0,
      cancelId: 0,
    })
    .then((result) => {
      if (result.response === 1) void shell.openPath(outcome.backupDir);
    })
    .catch(() => {});
}

/**
 * Menu-driven counterpart of the automatic recovery: "go back to the config
 * that last booted", with the same backup guarantee.
 */
async function manualProfileRollback() {
  const changes = profileGuard.diff();
  if (changes === null) {
    dialog.showMessageBoxSync(mainWindow ?? undefined, {
      type: 'info',
      title: `${APP_TITLE} — 回退配置`,
      message: '还没有可用的配置快照',
      detail: '配置快照会在内核成功启动后自动生成。',
      buttons: ['好的'],
    });
    return;
  }
  if (changes.changed.length === 0) {
    dialog.showMessageBoxSync(mainWindow ?? undefined, {
      type: 'info',
      title: `${APP_TITLE} — 回退配置`,
      message: '当前配置与上次成功启动时一致',
      detail: `快照时间：${new Date(changes.good.savedAt).toLocaleString()}`,
      buttons: ['好的'],
    });
    return;
  }
  const choice = dialog.showMessageBoxSync(mainWindow ?? undefined, {
    type: 'warning',
    title: `${APP_TITLE} — 回退配置`,
    message: '回退到上次成功启动的配置？',
    detail:
      `快照时间：${new Date(changes.good.savedAt).toLocaleString()}\n\n` +
      `将被恢复：\n${changes.changed.map((entry) => `· ${entry.rel}`).join('\n')}\n\n` +
      `当前配置会先备份到：\n${profileGuard.backupRoot()}\n\n` +
      '正在运行的会话会被中断。',
    buttons: ['回退并重启内核', '取消'],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice !== 0) return;

  let outcome = null;
  try {
    outcome = profileGuard.restoreLastGood({ output: kernelOutput.join('\n'), detail: '用户手动回退配置' });
  } catch (error) {
    log(`profile-guard: manual rollback failed: ${error.message}`);
  }
  if (outcome === null || !outcome.recovered) {
    dialog.showErrorBox(`${APP_TITLE} — 回退配置`, '回退失败，未做任何改动。请查看运行日志。');
    return;
  }
  // A manually restored config is as good as the automatic stage 1: if it still
  // fails, safe mode remains available.
  configRecoveryStage = Math.max(configRecoveryStage, 1);
  log(`profile-guard: manual rollback restored ${outcome.restored.join(', ') || '(nothing)'}`);
  notifyConfigRecovery(outcome, '用户手动回退');
  void restartRuntime();
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
    // Hidden rather than absent: the application menu still owns every
    // accelerator, and the visible bar is drawn inside the page so that the
    // background runs behind it. `视图 → 使用系统菜单栏` brings this one back.
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.setMenuBarVisibility(!pageMenuBar);
  desktopMenu = createDesktopMenu({
    contents: mainWindow.webContents,
    // Built fresh on every draw, like `buildMenu` does, because several labels
    // and enabled states are read live. Note this passes the *built menu*: the
    // context object is `buildMenuData`'s input, not its output, and handing
    // that over instead is what left the page bar undefined — the app log said
    // "menu: bar injection said error: MENUS is not iterable".
    getMenu: () => ({ ...buildMenuData(menuContext()), pageMenu: pageMenuBar }),
    setChannel: (name) => void setChannel(name),
    log,
  });
  desktopMenu.install();

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

/**
 * Everything the menu definition needs from the shell.
 *
 * Kept in one function so the native menu and the page's own bar cannot be built
 * from different state — they are two renderings of the same definition, and
 * `buildMenuData` is called fresh each time so live labels and enabled states
 * (the update channel, the snapshot description, whether a background is set)
 * are current in both.
 */
function menuContext() {
  return {
    runtimeManager,
    profileGuard,
    backgroundManager,
    appUrl: () => appUrl,
    mainWindow: () => mainWindow,
    nativeMenuBar: () => !pageMenuBar,
    setNativeMenuBar: (useNative) => {
      pageMenuBar = !useNative;
      writeMenuState();
      buildMenu();
    },
    dshHome,
    logDir,
    restartRuntime,
    setChannel,
    manualProfileRollback,
    manualCheck,
    doRollback,
    showAbout,
    rebuildMenu: () => buildMenu(),
  };
}

/**
 * Build the menu once and use it for both bars.
 *
 * `buildMenuData` is the single definition; the native menu is generated from it
 * with `toTemplate`, and the page's own bar is drawn from the same data by
 * `electron/desktop-menu.js`. Adding an item in one place therefore reaches both
 * — there is no second list to forget.
 */
function buildMenu() {
  const menu = buildMenuData(menuContext());

  Menu.setApplicationMenu(Menu.buildFromTemplate(toTemplate(menu.data, menu.commands)));
  // Hidden, never removed: the application menu is what still owns every
  // accelerator (F5, F12, Ctrl+C, Alt+F4), so hiding the bar costs no shortcuts.
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.setMenuBarVisibility(!pageMenuBar);
  }
  desktopMenu?.refresh();
}

/** The About box, kept out of the menu definition so it stays readable. */
function showAbout() {
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
