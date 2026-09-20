'use strict';

/**
 * Render the real DSH Web GUI with the desktop background applied, and write a
 * PNG. This is the eyeball check for `electron/background.js`: it loads the
 * production module, so what it captures is what the shell injects — papers
 * over nothing, and skips the rebuild-and-relaunch cycle.
 *
 * Run it with the Electron that the desktop build already downloaded:
 *
 *   cd desktop
 *   $env:PREVIEW_OUT   = "$PWD\shot.png"
 *   $env:PREVIEW_URL   = 'http://127.0.0.1:PORT/?token=...'   # optional
 *   $env:PREVIEW_CLICK_TEXT = '修复背景'                       # optional
 *   .\node_modules\electron\dist\electron.exe scripts\preview-background.cjs
 *
 * Configuration is read from PREVIEW_* environment variables rather than argv,
 * because Chromium treats a positional argument that looks like a URL as a page
 * to open and never hands it to the app.
 *
 *   PREVIEW_OUT        output PNG (default ./shot.png next to this script)
 *   PREVIEW_URL        an already running `dsh web` URL to render
 *   PREVIEW_DSH_HOME   DSH_HOME for the private runtime it boots when no URL is
 *                      given (default: ../.preview-dsh-home)
 *   PREVIEW_USER_DATA  Chromium profile for the preview process, kept away from
 *                      the installed app (default: ../.preview-userdata)
 *   PREVIEW_SETTINGS_DIR
 *                      directory holding background.json + backgrounds/, read
 *                      but never written (default: the installed app's own user
 *                      data directory, so the preview shows the real settings)
 *   PREVIEW_WIDTH      window width (default 1424)
 *   PREVIEW_HEIGHT     window height (default 855)
 *   PREVIEW_SETTLE     ms to wait for the app to render (default 6000)
 *   PREVIEW_CLICK      CSS selector to click before capturing
 *   PREVIEW_CLICK_TEXT click the first session row containing this text
 *   PREVIEW_WINDOW     `app` (default) or `settings`, to capture the background
 *                      settings window instead of the application
 *   PREVIEW_FRAMES     captures to take (default 1). More than one turns the run
 *                      into an animation check: captures are hashed and compared,
 *                      which is the only way to tell a playing video or an
 *                      animated GIF from a still frame of one.
 *   PREVIEW_FRAME_GAP  ms between captures (default 900)
 *   PREVIEW_VIDEO      a video file to test the video background with. It is
 *                      copied into the settings directory as `current.<ext>` and
 *                      enabled, which is exactly what the picker does — the
 *                      desktop shell has no bundled video fixture, because a
 *                      syntactically valid file is not something a test script
 *                      should be inventing.
 *   PREVIEW_RESIZE_REPEAT
 *                      with `PREVIEW_WINDOW=settings`, drive the window refit
 *                      this many times and report whether the size moved
 *   PREVIEW_CLOSE_SETTINGS
 *                      with `PREVIEW_WINDOW=settings`, close the settings window
 *                      and report what happened to the main window
 *   PREVIEW_MOVE_X     move the settings window to this x before refitting, so
 *                      the moved-window case is covered too
 *   PREVIEW_DRAG_BY    drag the settings window's title bar by this many pixels
 *                      with the real mouse before refitting
 *   PREVIEW_MENU       `page` to install the page's own menu bar, `native` for
 *                      the system one. It is drawn from the shell's *real* menu
 *                      definition, built here against stubs — using a stand-in
 *                      definition instead is what let a wiring bug through, since
 *                      that bypassed `buildMenuData` entirely.
 *   PREVIEW_MENU_CLICK id of a command to click, through the page's console
 *                      channel, to prove a click gets back to the shell
 *   PREVIEW_LOG        append every line to this file as well as stdout, because
 *                      `app.exit()` does not flush stdout
 *
 * @module desktop/scripts/preview-background
 */

const { app, BrowserWindow, Menu, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { createBackgroundManager } = require(path.join(__dirname, '..', 'electron', 'background.js'));
const desktopMenuModule = require(path.join(__dirname, '..', 'electron', 'desktop-menu.js'));
const { createDesktopMenu, BAR_ID, CONSOLE_PREFIX } = desktopMenuModule;

const env = (name, fallback) => process.env[`PREVIEW_${name}`] ?? fallback;

const OUT = path.resolve(env('OUT', path.join(__dirname, 'shot.png')));
const DSH_HOME = env('DSH_HOME', path.join(__dirname, '..', '.preview-dsh-home'));
const URL_ARG = env('URL', null);
const WIDTH = Number(env('WIDTH', '1424'));
const HEIGHT = Number(env('HEIGHT', '855'));
const SETTLE = Number(env('SETTLE', '6000'));
const FRAMES = Math.max(1, Number(env('FRAMES', '1')));
const FRAME_GAP = Number(env('FRAME_GAP', '900'));
const CHROME_DIR = path.resolve(env('USER_DATA', path.join(__dirname, '..', '.preview-userdata')));
const SETTINGS_DIR = path.resolve(
  env('SETTINGS_DIR', path.join(process.env.APPDATA ?? '', 'DeepSeek Harness')),
);
/** Where a multi-frame run writes its extra PNGs, with the frame number appended. */
const OUT_FRAME = (index) => OUT.replace(/\.png$/i, `-${index}.png`);
/**
 * Optional log file. `app.exit()` does not flush the process's stdout, so on
 * Windows a run that ends through it loses its last lines — which are exactly
 * the ones worth reading. `PREVIEW_LOG` mirrors every line to a file that is
 * appended and flushed as it goes.
 */
const LOG_FILE = env('LOG', null);

const NODE_EXE = path.join(__dirname, '..', 'runtime', 'node', 'node.exe');
const DSH_BIN = path.join(__dirname, '..', 'runtime', 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

app.setPath('userData', CHROME_DIR);
// Chromium's helper processes cannot open the named pipes they need inside a
// sandboxed agent environment; everything else about the render is unchanged.
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.disableHardwareAcceleration();

const log = (message) => {
  const line = `[preview] ${message}\n`;
  process.stdout.write(line);
  if (LOG_FILE !== null) {
    try {
      fs.appendFileSync(LOG_FILE, line, 'utf8');
    } catch {
      /* logging must never break the run */
    }
  }
};

let child = null;
let win = null;

/**
 * A stand-in for the shell's menu, so the manager's `onChange` can be wired the
 * way `main.js` wires it. That wiring runs on the settings path — every slider
 * move and every close — so leaving it out (as this harness used to) hides a
 * whole class of behaviour.
 */
let previewMenu = null;
/** The in-page menu bar for the app window, when the menu scenario is on. */
let mainMenu = null;

const backgroundManager = createBackgroundManager({
  userDataDir: SETTINGS_DIR,
  log,
  getMainWindow: () => win,
  onChange: () => {
    backgroundManager.applyEnvironment();
    previewMenu?.();
  },
});
backgroundManager.registerScheme();

// ─── capture helpers ─────────────────────────────────────────────────────────

/**
 * Cheap content fingerprint of a captured frame, plus the raw bitmap.
 *
 * Two captures of a page whose background is playing differ in tens of
 * thousands of bytes; two captures of a still one differ only where something in
 * the application itself happened to animate. The difference is reported rather
 * than asserted, and the caller reads it.
 *
 * @param {Electron.NativeImage} image
 * @returns {{ digest: string, bytes: number, data: Buffer }}
 */
function fingerprint(image) {
  const data = image.toBitmap();
  return { digest: crypto.createHash('sha1').update(data).digest('hex').slice(0, 12), bytes: data.length, data };
}

/**
 * Byte-level difference between two frames, ignoring the low bits of each
 * channel so that video compression noise does not read as motion.
 * @returns {number} differing bytes per pixel.
 */
function difference(before, after) {
  const length = Math.min(before.bytes, after.bytes);
  let differing = 0;
  for (let i = 0; i < length; i += 1) {
    if (Math.abs(before.data[i] - after.data[i]) > 8) differing += 1;
  }
  return differing / (length / 4);
}

/** What the injected backdrop layer and its player look like from the page. */
function playerProbeScript() {
  return `(() => {
    const host = document.querySelector('#dshbg-video');
    const video = host === null ? null : host.querySelector('video');
    const backdrop = host === null ? null : getComputedStyle(host);
    const body = getComputedStyle(document.body);
    return {
      // The layer carries the scrim in both modes, and must sit behind the app.
      backdrop: backdrop === null
        ? null
        : {
            zIndex: backdrop.zIndex,
            position: backdrop.position,
            backgroundImage: backdrop.backgroundImage,
          },
      bodyBackground: body.backgroundImage,
      video: video === null
        ? null
        : {
            // Content digest of the file, so a swap must change it.
            rev: host.dataset.rev ?? null,
            src: (video.currentSrc ?? '').replace(/\\?.*$/, ''),
            paused: video.paused,
            readyState: video.readyState,
            networkState: video.networkState,
            width: video.videoWidth,
            height: video.videoHeight,
            duration: Number.isFinite(video.duration) ? Math.round(video.duration * 100) / 100 : null,
            currentTime: Math.round(video.currentTime * 100) / 100,
            loop: video.loop,
            muted: video.muted,
            playbackRate: video.playbackRate,
            objectFit: getComputedStyle(video).objectFit,
            error: video.error === null ? null : (video.error.message || 'code ' + video.error.code),
          },
    };
  })()`;
}

/**
 * Capture `FRAMES` frames `FRAME_GAP` apart, write each to disk, and report the
 * digest and how much each differs from the first.
 * @param {Electron.WebContents} contents
 * @returns {Promise<{ digest: string, changed: number, file: string }[]>}
 */
async function captureFrames(contents) {
  const frames = [];
  for (let index = 0; index < FRAMES; index += 1) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, FRAME_GAP));
    const image = await contents.capturePage();
    const shot = { ...fingerprint(image), file: index === 0 ? OUT : OUT_FRAME(index) };
    fs.writeFileSync(shot.file, image.toPNG());
    frames.push({
      ...shot,
      changed: index === 0 ? 0 : difference(frames[0], shot),
    });
    log(
      `frame ${index}: digest=${shot.digest} changed=${frames[index].changed.toFixed(2)} B/px -> ${shot.file}`,
    );
  }
  return frames;
}

/** Boot a private runtime so the preview never disturbs a running shell. */
function startRuntime() {
  return new Promise((resolve, reject) => {
    child = spawn(NODE_EXE, [DSH_BIN, 'web', '--port', '0', '--no-open'], {
      cwd: DSH_HOME,
      env: { ...process.env, DSH_HOME },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let pending = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      const match = /dsh web:\s+(https?:\/\/\S+)/.exec(pending);
      if (match !== null) resolve(match[1]);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => process.stdout.write(`[runtime] ${chunk}`));
    child.on('exit', (code) => reject(new Error(`runtime exited early: ${code}`)));
    setTimeout(() => reject(new Error('runtime did not report a URL in 120s')), 120000);
  });
}

/** Click something in the app before capturing, so views behind a click work. */
async function clickBeforeCapture() {
  const selector = env('CLICK', null);
  const text = env('CLICK_TEXT', null);
  if (selector === null && text === null) return;
  const script =
    text !== null
      ? `(() => {
           const rows = Array.from(document.querySelectorAll('[role="treeitem"]'));
           const row = rows.find((node) => node.textContent.includes(${JSON.stringify(text)}));
           if (row === undefined) return 'not found';
           row.click();
           return row.textContent.slice(0, 40);
         })()`
      : `(() => {
           const el = document.querySelector(${JSON.stringify(selector)});
           if (el === null) return 'not found';
           el.click();
           return true;
         })()`;
  log(`clicked: ${await win.webContents.executeJavaScript(script)}`);
  await new Promise((resolve) => setTimeout(resolve, 6000));
}

/**
 * Create and load the main window, exactly as the app path does.
 *
 * Factored out because one scenario — `CLOSE_SETTINGS` — needs a real main
 * window *and* the shell's `onChange` wiring (which the manager's own harness
 * does not have) to reproduce what happens when the settings window closes.
 *
 * @param {string} url
 */
async function openAppWindow(url) {
  win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    backgroundColor: backgroundManager.windowBackground(),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  backgroundManager.attachWindow(win);
  win.webContents.on('render-process-gone', (_event, details) => log(`renderer gone: ${JSON.stringify(details)}`));
  win.webContents.on('did-fail-load', (_event, code, description) => log(`load failed: ${code} ${description}`));
  await win.loadURL(url);
  log(`nativeTheme: source=${nativeTheme.themeSource} dark=${nativeTheme.shouldUseDarkColors}`);

  // Mirror the shell's main-window setup: the application menu is registered
  // once, its bar is hidden (the page draws its own), and every change to the
  // background re-runs that visibility pass — which is what `onChange` above
  // triggers, and what the plain harness used to leave out.
  previewMenu = () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.setMenuBarVisibility(false);
    }
    mainMenu?.refresh();
  };
  previewMenu();

  if (env('MENU', '') !== '') {
    const built = desktopMenuModule.buildMenuData(previewMenuContext([]));
    Menu.setApplicationMenu(Menu.buildFromTemplate(desktopMenuModule.toTemplate(built.data, built.commands)));
    mainMenu = createDesktopMenu({
      contents: win.webContents,
      getMenu: () => ({ ...desktopMenuModule.buildMenuData(previewMenuContext([])), pageMenu: true }),
      setChannel: () => {},
      log,
    });
    mainMenu.install();
  }
}

/**
 * Open the settings window over a loaded app window, close it, and report what
 * that did to the main window.
 *
 * The reported symptom is "closing the background dialog hides the main
 * window", so the state has to be sampled, not reasoned about. The manager is
 * rebuilt here with the shell's `onChange` wiring, because that is what runs on
 * the settings path and what the plain harness leaves out.
 */
async function closeSettingsScenario() {
  await new Promise((resolve) => setTimeout(resolve, SETTLE));
  // The app shows this window; a hidden one cannot exhibit "the window got
  // hidden", so it has to be visible for the check to mean anything.
  win.show();
  win.focus();
  if (env('MAXIMIZE', '') !== '') win.maximize();
  await new Promise((resolve) => setTimeout(resolve, 800));
  const snapshot = (label) => {
    if (win === null || win.isDestroyed()) return `${label}: the main window is GONE`;
    return (
      `${label}: visible=${win.isVisible()} minimized=${win.isMinimized()} ` +
      `maximized=${win.isMaximized()} focused=${win.isFocused()} menuBar=${win.isMenuBarVisible()} ` +
      `fullscreen=${win.isFullScreen()} bounds=${JSON.stringify(win.getBounds())}`
    );
  };
  log(snapshot('before settings'));

  // A watchdog, because the interesting failure may only exist for a moment.
  // It records who owns the *foreground* window, not just whether the main
  // window is visible: the reported symptom is "the interface jumps to another
  // application", which is a question about z-order and activation, and
  // `isVisible()` cannot see it.
  let watching = true;
  const samples = [];
  const foreground = () => {
    try {
      const script = `
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FG {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
'@ -ErrorAction SilentlyContinue
        $h = [FG]::GetForegroundWindow()
        Write-Output "$([int64]$h) $([FG]::IsIconic($h))"
      `;
      return execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        encoding: 'utf8',
        timeout: 5000,
      }).trim();
    } catch (error) {
      return `foreground-probe-failed: ${error.message}`;
    }
  };
  const watchdog = (async () => {
    let last = null;
    while (watching) {
      if (win !== null && !win.isDestroyed()) {
        const state = `v=${win.isVisible() ? 1 : 0} m=${win.isMinimized() ? 1 : 0} f=${win.isFocused() ? 1 : 0}`;
        if (state !== last) {
          samples.push(`${state} | fg=${foreground()}`);
          last = state;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  })();

  backgroundManager.openSettings();
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const settingsWindow = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === '背景设置');
  if (settingsWindow === undefined) throw new Error('the settings window did not open');
  log(snapshot('with settings open'));
  log(`windows: ${BrowserWindow.getAllWindows().length}`);

  // Switch the background while the dialog is open — the user's reproduction
  // says that is what precedes the jump.
  if (env('CHURN_SETTINGS', '') !== '') {
    await settingsWindow.webContents
      .executeJavaScript(`window.dshBackground.update({ uiOpacity: 0.42 })`, true)
      .catch((error) => log(`settings churn failed: ${error.message}`));
    await new Promise((resolve) => setTimeout(resolve, 700));
    log(snapshot('after switching the background'));
  }

  // The shell's `onChange` does two things the manager cannot: it re-applies the
  // environment (nativeTheme, window colour) and it rebuilds the menu, which
  // walks every window and sets its menu-bar visibility. That pass is the one
  // thing here that touches the main window while the dialog owns the
  // foreground, so it is a candidate for knocking the dialog (or the main
  // window) out of the foreground — measure it instead of suspecting it.
  if (env('PROBE_ENV', '') !== '') {
    for (const step of ['applyEnvironment', 'menuBarVisibility']) {
      log(`probe ${step}: before fg=${foreground()}`);
      if (step === 'applyEnvironment') backgroundManager.applyEnvironment();
      else for (const window of BrowserWindow.getAllWindows()) window.setMenuBarVisibility(false);
      await new Promise((resolve) => setTimeout(resolve, 600));
      log(`probe ${step}: after fg=${foreground()} mainFocused=${win.isFocused()}`);
    }
  }

  // Close it the way the dialog's own 关闭 button does.
  await settingsWindow.webContents.executeJavaScript('window.close()', true).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 2000));
  watching = false;
  await watchdog;
  log(snapshot('after settings close'));
  log(`windows after close: ${BrowserWindow.getAllWindows().length}`);
  log(`state changes: ${samples.length}`);
  for (const sample of samples) log(`  ${sample}`);

  const image = await win.webContents.capturePage();
  fs.writeFileSync(OUT, image.toPNG());
  log(`wrote ${OUT}`);
  app.exit(0);
}

/**
 * Capture the background settings window instead of the app, and check that its
 * content fits — the window is sized to its content rather than by the user, so
 * a new card or a longer hint can silently clip the footer.
 */
async function captureSettingsWindow() {
  backgroundManager.openSettings();
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const settingsWindow = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === '背景设置');
  if (settingsWindow === undefined) throw new Error('the settings window did not open');
  const probe = await settingsWindow.webContents.executeJavaScript(
    `(() => {
       const main = document.querySelector('main');
       const footer = document.querySelector('.footer').getBoundingClientRect();
       const cards = Array.from(document.querySelectorAll('.card')).map((card) => Math.round(card.getBoundingClientRect().bottom));
       return {
         innerHeight: window.innerHeight,
         // The cards scroll inside \`main\`; the footer sits outside it and must
         // always be on screen, however tall the cards get.
         scrollable: main.scrollHeight > main.clientHeight,
         scrollHeight: main.scrollHeight,
         clientHeight: main.clientHeight,
         cardBottoms: cards,
         videoCardShown: document.getElementById('videoCard').hidden === false,
         videoMeta: document.getElementById('videoMeta').textContent,
         footerTop: Math.round(footer.top),
         footerBottom: Math.round(footer.bottom),
         footerBottomExact: Math.round(footer.bottom * 1000) / 1000,
         innerHeightExact: window.innerHeight,
         footerVisible: footer.bottom <= window.innerHeight + 1 && footer.top >= -1,
       };
     })()`,
  );
  log(`settings window: ${JSON.stringify(probe)}`);

  // The settings window is deliberately not self-sizing: it is created at a
  // fixed size, and a window whose size depends on its own layout and on where
  // it was dragged is exactly what drifted before. So what is checked here is
  // that the size does not move while the state changes — settings changes,
  // moves and drags included — and that the footer still fits inside it.
  const repeats = Number(env('RESIZE_REPEAT', '0'));
  if (repeats > 0) {
    const sizes = [];
    const measure = async (label) => {
      const [width, height] = settingsWindow.getContentSize();
      const { x } = settingsWindow.getBounds();
      const inner = await settingsWindow.webContents.executeJavaScript(
        '({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })',
        true,
      );
      sizes.push({ width, height, x });
      log(`${label}: content=${width}x${height} inner=${inner.w}x${inner.h} dpr=${inner.dpr} x=${x}`);
    };
    // A settings change is what used to drive the refit; the update goes through
    // the same IPC the slider uses.
    const churn = async () => {
      for (let index = 0; index < repeats; index += 1) {
        await settingsWindow.webContents.executeJavaScript(
          `window.dshBackground.update({ uiOpacity: ${0.2 + (index % 5) * 0.1} })`,
          true,
        );
      }
    };

    await measure('as opened');
    await churn();
    await measure('after settings churn');
    const dragBy = Number(env('DRAG_BY', '0'));
    if (dragBy !== 0) {
      await dragWindowBy(settingsWindow, dragBy);
      await measure('after drag');
      await churn();
      await measure('after churn + drag');
    } else {
      settingsWindow.setBounds({ ...settingsWindow.getBounds(), x: Number(env('MOVE_X', '120')) });
      await new Promise((resolve) => setTimeout(resolve, 400));
      await measure('after move');
      await churn();
      await measure('after churn + move');
    }

    const widths = sizes.map((size) => size.width);
    const heights = sizes.map((size) => size.height);
    log(
      `stability: widthStable=${widths.every((value) => value === widths[0]) ? 'yes' : 'NO'} ` +
        `heightStable=${heights.every((value) => value === heights[0]) ? 'yes' : 'NO'} ` +
        `widths=${widths.join(', ')} heights=${heights.join(', ')}`,
    );
  }

  // Closing the settings window must leave the main window alone. Reported
  // symptom: "closing the background dialog hides the main window". Capture the
  // main window's state before and after, so a change is visible as data rather
  // than as a guess about which Electron call is responsible.
  if (env('CLOSE_SETTINGS', '') !== '') {
    const snapshot = (label) => {
      const main = win;
      if (main === null || main.isDestroyed()) return `${label}: the main window is GONE`;
      return (
        `${label}: visible=${main.isVisible()} minimized=${main.isMinimized()} ` +
        `focused=${main.isFocused()} menuBar=${main.isMenuBarVisible()}`
      );
    };
    log(snapshot('before close'));
    settingsWindow.close();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    log(snapshot('after close'));
    log(`windows remaining: ${BrowserWindow.getAllWindows().length}`);
    const image = await win.webContents.capturePage();
    fs.writeFileSync(OUT, image.toPNG());
    log(`wrote ${OUT}`);
    app.exit(0);
    return;
  }

  const image = await settingsWindow.webContents.capturePage();
  fs.writeFileSync(OUT, image.toPNG());
  log(`wrote ${OUT}`);
  app.exit(0);
}

/**
 * Drag a window by its title bar with the real mouse, so that whatever Windows
 * does to a window that has genuinely been dragged — frame styles, DPI
 * reassessment, work-area clamping — is part of the state being tested.
 *
 * `setBounds` is not a substitute: it asks the compositor to put the window
 * somewhere, while a drag goes through the non-client hit test and the move
 * loop. The desktop shell's bug only appeared after a real drag.
 *
 * @param {BrowserWindow} win
 * @param {number} dx - pixels to move left (negative) or right.
 */
async function dragWindowBy(win, dx) {
  const bounds = win.getBounds();
  // The title bar sits inside the frame; the caption is what a drag grabs.
  const fromX = Math.round(bounds.x + bounds.width / 2);
  const fromY = Math.round(bounds.y + 18);
  const toX = fromX + dx;
  const script = `
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Mouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  public const uint LEFTDOWN = 0x0002;
  public const uint LEFTUP = 0x0004;
}
'@
[Mouse]::SetCursorPos(${fromX}, ${fromY})
Start-Sleep -Milliseconds 250
[Mouse]::mouse_event([Mouse]::LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 150
${Array.from({ length: 12 }, (_, index) => Math.round(fromX + (dx * (index + 1)) / 12))
  .map((x) => `[Mouse]::SetCursorPos(${x}, ${fromY})\nStart-Sleep -Milliseconds 40`)
  .join('\n')}
Start-Sleep -Milliseconds 150
[Mouse]::mouse_event([Mouse]::LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
`;
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 600));
}

/** `executeJavaScript` that reports what went wrong instead of throwing. */
async function evaluate(contents, script, label) {
  try {
    return await contents.executeJavaScript(script, true);
  } catch (error) {
    log(`${label} threw: ${error.message}`);
    return null;
  }
}

/** Same, but the script catches its own errors so the message is readable. */
async function evaluateWrapped(contents, body, label) {
  return evaluate(
    contents,
    `(() => { try { return (${body})(document); } catch (error) { return 'error: ' + (error && error.message); } })()`,
    label,
  );
}

/**
 * The context `main.js` passes to `buildMenuData`, with the live parts stubbed.
 *
 * Kept close to the real thing on purpose: the point of building the menu here
 * is to exercise the shell's own definition, so that a wiring mistake shows up
 * in the preview instead of in a user's window.
 *
 * @param {string[]} clicked - collects the commands that were run.
 */
function previewMenuContext(clicked) {
  const describe = () => ({
    active: '0.1.5-rc.2',
    bundled: '0.1.5-rc.2',
    source: 'bundled',
    channel: 'next',
    previous: null,
    installed: [],
    lastCheck: null,
  });
  return {
    runtimeManager: {
      CHANNELS: ['latest', 'next', 'alpha'],
      describe,
      writeState: () => {},
    },
    profileGuard: {
      hasSnapshot: () => false,
      describeSnapshot: () => '配置快照：无',
      backupRoot: () => 'C:\\backups',
    },
    backgroundManager: {
      hasBackground: () => true,
      openSettings: () => clicked.push('background-settings'),
      clearBackground: () => clicked.push('clear-background'),
    },
    appUrl: () => 'http://127.0.0.1:1234/?token=x',
    mainWindow: () => null,
    nativeMenuBar: () => false,
    setNativeMenuBar: () => {},
    dshHome: () => 'C:\\Users\\x\\.dsh',
    logDir: 'C:\\logs',
    restartRuntime: () => clicked.push('restart-runtime'),
    setChannel: (name) => clicked.push(`channel:${name}`),
    manualProfileRollback: () => clicked.push('rollback-profile'),
    manualCheck: () => clicked.push('manual-check'),
    doRollback: () => clicked.push('rollback'),
    showAbout: () => clicked.push('about'),
    rebuildMenu: () => {},
  };
}

/**
 * Install the in-page menu bar into the app window, and check it.
 *
 * It is drawn from the shell's real menu definition (see `previewMenuContext`),
 * so the wiring between `buildMenuData` and the bar is exercised rather than
 * assumed. What is being verified is the part that is easy to get wrong — that
 * the bar renders over the page with all four menus, that the app is displaced
 * by exactly the bar's height *without* growing a scrollbar, that the bar is
 * translucent (the whole point of drawing it in the page), that it comes back
 * after being removed, and that a click travels back to the main process.
 *
 * @param {BrowserWindow} win
 * @returns {Promise<object | null>} the probe, or null when not requested.
 */
async function installPreviewMenu(win) {
  if (env('MENU', '') === '') return null;
  const pageMenu = env('MENU', 'page') !== 'native';

  const clicked = [];
  // The shell's own definition, built against stubs, wired exactly the way
  // `showMainWindow` wires it. Anything the real shell has to hand over for the
  // bar to draw — the shape `getMenu` returns, in particular — is therefore
  // exercised here, instead of being assumed.
  const { buildMenuData, toTemplate } = desktopMenuModule;
  const menu = createDesktopMenu({
    contents: win.webContents,
    getMenu: () => ({
      ...buildMenuData(previewMenuContext(clicked)),
      pageMenu,
    }),
    setChannel: (name) => clicked.push(`channel:${name}`),
    log,
  });
  const built = buildMenuData(previewMenuContext(clicked));
  // Electron validates the template's shape too; a menu that the native bar
  // rejects would take the app down at startup.
  Menu.setApplicationMenu(Menu.buildFromTemplate(toTemplate(built.data, built.commands)));
  menu.install();
  const drew = await menu.refresh();
  if (drew !== 'ok') log(`menu first draw: ${drew}`);
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const requested = env('MENU_CLICK', null);
  const probe = await evaluate(
    win.webContents,
    `(() => {
       const bar = document.getElementById(${JSON.stringify(BAR_ID)});
       const body = getComputedStyle(document.body);
       const tops = bar === null ? [] : Array.from(bar.querySelectorAll(':scope > .top')).map((item) => item.textContent);
       // What actually occupies the strip the bar sits in. If the bar is missing,
       // "an empty gap above the app" is exactly what the user sees, so the probe
       // has to say whether the bar exists, where it is, and what is on top of it.
       const centre = document.elementFromPoint(60, 14);
       return {
         barPresent: bar !== null,
         barHeight: bar === null ? null : Math.round(bar.getBoundingClientRect().height),
         barPosition: bar === null ? null : getComputedStyle(bar).position,
         barBackground: bar === null ? null : getComputedStyle(bar).backgroundColor,
         barColor: bar === null ? null : getComputedStyle(bar).color,
         barDisplay: bar === null ? null : getComputedStyle(bar).display,
         barZIndex: bar === null ? null : getComputedStyle(bar).zIndex,
         barParent: bar === null ? null : bar.parentElement.tagName,
         barDisabledVar: bar === null ? null : getComputedStyle(bar).getPropertyValue('--dshbg-menu-bg').trim(),
         bodyPaddingTop: body.paddingTop,
         bodyPaddingTopInline: document.body.style.paddingTop || null,
         bodyBoxSizing: body.boxSizing,
         topLabels: tops,
         // Whatever wins the hit test at the top-left of the window.
         topmostAtBar: centre === null ? null : centre.tagName + '.' + (centre.className || ''),
         // The bar displaces the app by its own height. If the page then becomes
         // taller than the window it grows a scroller, which hides the app's
         // bottom row — so measure both dimensions rather than assuming.
         scrollbar: {
           bodyScrolls: document.body.scrollHeight > document.body.clientHeight,
           bodyClient: document.body.clientHeight,
           bodyScroll: document.body.scrollHeight,
           htmlScrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight,
           windowInner: window.innerHeight,
           windowScrollY: window.scrollY,
         },
         // The row the app keeps at the bottom of the window (its settings
         // button lives there): it must still be inside the viewport.
         bottomMost: (() => {
           const nodes = Array.from(document.body.querySelectorAll('*'));
           let lowest = 0;
           let who = null;
           for (const node of nodes) {
             const box = node.getBoundingClientRect();
             if (box.height === 0 || box.width === 0) continue;
             if (box.bottom > lowest) {
               lowest = box.bottom;
               who = node.tagName + '.' + String(node.className || '').slice(0, 40);
             }
           }
           return { bottom: Math.round(lowest), who, insideViewport: lowest <= window.innerHeight + 1 };
         })(),
       };
     })()`,
    'menu probe',
  );

  // Open the menu holding the command we are going to click — a user would —
  // so a submenu renders and the click has something to land on. The menu to
  // open is found by reading the data the bar was drawn from, not by clicking
  // through every top-level item until one happens to contain the row.
  const wanted = requested ?? 'reload-window';
  const index = built.data.findIndex((top) => JSON.stringify(top.items).includes(`"${wanted}"`));
  await evaluate(
    win.webContents,
    `(() => {
       const tops = document.querySelectorAll('#${BAR_ID} > .top');
       const index = ${index};
       if (index >= 0 && tops[index] !== undefined) tops[index].click();
       return index;
     })()`,
    'menu open',
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  const opened = await evaluateWrapped(
    win.webContents,
    `function () {
       const panel = document.querySelector('#${BAR_ID} > .panel');
       if (panel === null) return null;
       const rows = Array.from(panel.querySelectorAll(':scope > .item')).map((row) => ({
         label: row.querySelector('.label')?.textContent ?? '',
         cmd: row.dataset.cmd ?? null,
         enabled: row.dataset.off !== '1' && !row.classList.contains('info'),
       }));
       const bounds = panel.getBoundingClientRect();
       return { rows, left: Math.round(bounds.left), top: Math.round(bounds.top), width: Math.round(bounds.width) };
     }`,
    'menu panel',
  );
  if (opened !== null) log(`menu panel: ${JSON.stringify(opened)}`);

  // The reason the bar needs to be resilient: the application finishes booting
  // after the page loads, and rebuilding its root takes foreign nodes with it.
  // Simulate exactly that — delete the bar out from under the observer — and
  // require it to come back on its own.
  const beforeWipe = await evaluate(
    win.webContents,
    `(() => { document.getElementById(${JSON.stringify(BAR_ID)})?.remove(); return 'wiped'; })()`,
    'menu wipe',
  );
  await new Promise((resolve) => setTimeout(resolve, 900));
  const afterWipe = await evaluateWrapped(
    win.webContents,
    `function () {
       const bar = document.getElementById(${JSON.stringify(BAR_ID)});
       return {
         restored: bar !== null,
         height: bar === null ? null : Math.round(bar.getBoundingClientRect().height),
         padding: getComputedStyle(document.body).paddingTop,
       };
     }`,
    'menu restore',
  );
  log(`menu wipe=${beforeWipe} restore=${JSON.stringify(afterWipe)}`);

  // Click a real item and let the console bridge carry it back. This comes last
  // on purpose: it opens the menu, which closes the one the panel probe opened,
  // and it runs against the bar the wipe above restored.
  if (requested !== null) {
    await evaluate(
      win.webContents,
      `(() => {
         const tops = document.querySelectorAll('#${BAR_ID} > .top');
         if (tops[${index}] !== undefined) tops[${index}].click();
         return ${index};
       })()`,
      'menu reopen',
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    const result = await evaluate(
      win.webContents,
      `(() => {
         const row = Array.from(document.querySelectorAll('#${BAR_ID} .item')).find(
           (candidate) => candidate.dataset.cmd === ${JSON.stringify(requested)},
         );
         if (row === undefined) return 'not-found';
         row.click();
         return 'clicked';
       })()`,
      'menu click',
    );
    log(`menu click ${requested}: ${result}`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    log(`menu commands received: ${JSON.stringify(clicked)}`);
  }
  void CONSOLE_PREFIX;

  return probe;
}

async function main() {
  // A video is put in place the way the picker puts it there, so the run
  // exercises the real path: copy it into the store, point the settings at it.
  // No video fixture is bundled or generated — a synthetic file that a decoder
  // rejects would prove nothing, and this shell only has to serve and play what
  // the user chose.
  const video = env('VIDEO', null);
  if (video !== null) {
    const source = path.resolve(video);
    if (!fs.existsSync(source)) {
      log(`FAILED: PREVIEW_VIDEO does not exist: ${source}`);
      app.exit(1);
      return;
    }
    const name = `current${path.extname(source).toLowerCase()}`;
    const store = path.join(SETTINGS_DIR, 'backgrounds');
    fs.mkdirSync(store, { recursive: true });
    fs.copyFileSync(source, path.join(store, name));
    fs.writeFileSync(
      path.join(SETTINGS_DIR, 'background.json'),
      `${JSON.stringify(
        {
          enabled: true,
          file: name,
          uiOpacity: 0.72,
          canvasOpacity: 0.32,
          dim: 0.25,
          palette: 'auto',
          playback: { loop: true, muted: true, speed: 1, pauseWhenHidden: false },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    log(`installed ${path.basename(source)} as ${name}`);
  }

  await app.whenReady();
  backgroundManager.install();
  backgroundManager.applyEnvironment();

  const settingsFile = path.join(SETTINGS_DIR, 'background.json');
  let settings = '（无 background.json，按未设置背景渲染）';
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch {
    log(`no background.json in ${SETTINGS_DIR}`);
  }
  log(`settings: ${JSON.stringify(settings)}`);

  if (env('WINDOW', 'app') === 'settings') {
    await captureSettingsWindow();
    return;
  }

  // Only boot a private runtime when no URL was handed in: the spawn is what
  // fails in an agent sandbox, and a running `dsh web` serves the same page.
  const url = URL_ARG ?? (await startRuntime());
  log(`loading ${url}`);
  await openAppWindow(url);

  if (env('CLOSE_SETTINGS', '') !== '') {
    await closeSettingsScenario();
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, SETTLE));
  await clickBeforeCapture();

  const menu = await installPreviewMenu(win);
  if (menu !== null) log(`menu: ${JSON.stringify(menu)}`);

  const probe = await win.webContents.executeJavaScript(
    `(() => {
      const body = getComputedStyle(document.body);
      const token = (name) => body.getPropertyValue(name).trim();
      const fade = document.querySelector('[class*="_fade"]');
      const seat = document.querySelector('[class*="_composerSeat"]');
      return {
        pageDark: document.body.hasAttribute('data-ds-dark-theme'),
        computedScheme: getComputedStyle(document.documentElement).colorScheme,
        // Carries the file's content digest, so it must change with the picture.
        bodyImageUrl: /url\\("([^"]+)"\\)/.exec(body.backgroundImage)?.[1] ?? null,
        label: token('--dsw-alias-label-primary'),
        canvas: token('--dsw-alias-bg-base'),
        sidebar: token('--dsw-specific-sidebar-fill'),
        input: token('--dsw-specific-input-major'),
        button: token('--dsw-alias-button-elevated-fill'),
        fadeBackground: fade === null ? null : getComputedStyle(fade).backgroundImage,
        seatBackground: seat === null ? null : getComputedStyle(seat).backgroundImage
      };
    })()`,
  );
  log(`page: ${JSON.stringify(probe)}`);
  log(`player: ${JSON.stringify(await win.webContents.executeJavaScript(playerProbeScript(), true))}`);

  const frames = await captureFrames(win.webContents);
  // With more than one capture, motion in the background is the assertion: a
  // still wallpaper only changes where the application itself animates.
  if (FRAMES > 1) log(`animation: changed=${frames.slice(1).map((frame) => frame.changed.toFixed(2)).join(', ')} B/px`);

  if (child !== null) child.kill();
  app.exit(0);
}

main().catch((error) => {
  log(`FAILED: ${error.stack ?? error.message}`);
  if (child !== null) child.kill();
  app.exit(1);
});

