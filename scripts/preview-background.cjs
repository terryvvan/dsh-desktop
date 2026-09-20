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
 *
 * @module desktop/scripts/preview-background
 */

const { app, BrowserWindow, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { createBackgroundManager } = require(path.join(__dirname, '..', 'electron', 'background.js'));

const env = (name, fallback) => process.env[`PREVIEW_${name}`] ?? fallback;

const OUT = path.resolve(env('OUT', path.join(__dirname, 'shot.png')));
const DSH_HOME = env('DSH_HOME', path.join(__dirname, '..', '.preview-dsh-home'));
const URL_ARG = env('URL', null);
const WIDTH = Number(env('WIDTH', '1424'));
const HEIGHT = Number(env('HEIGHT', '855'));
const SETTLE = Number(env('SETTLE', '6000'));
const CHROME_DIR = path.resolve(env('USER_DATA', path.join(__dirname, '..', '.preview-userdata')));
const SETTINGS_DIR = path.resolve(
  env('SETTINGS_DIR', path.join(process.env.APPDATA ?? '', 'DeepSeek Harness')),
);

const NODE_EXE = path.join(__dirname, '..', 'runtime', 'node', 'node.exe');
const DSH_BIN = path.join(__dirname, '..', 'runtime', 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

app.setPath('userData', CHROME_DIR);
// Chromium's helper processes cannot open the named pipes they need inside a
// sandboxed agent environment; everything else about the render is unchanged.
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.disableHardwareAcceleration();

const log = (message) => process.stdout.write(`[preview] ${message}\n`);

let child = null;
let win = null;

const backgroundManager = createBackgroundManager({
  userDataDir: SETTINGS_DIR,
  log,
  getMainWindow: () => win,
  onChange: () => {},
});
backgroundManager.registerScheme();

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
 * Capture the background settings window instead of the app, and check that its
 * content fits — the window is a fixed size, so an extra field would silently
 * clip the footer.
 */
async function captureSettingsWindow() {
  backgroundManager.openSettings();
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const settingsWindow = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === '背景设置');
  if (settingsWindow === undefined) throw new Error('the settings window did not open');
  const probe = await settingsWindow.webContents.executeJavaScript(
    `(() => {
       const footer = document.querySelector('.footer').getBoundingClientRect();
       const cards = Array.from(document.querySelectorAll('.card')).map((card) => Math.round(card.getBoundingClientRect().bottom));
       return {
         innerHeight: window.innerHeight,
         bodyScrollHeight: document.body.scrollHeight,
         cardBottoms: cards,
         footerTop: Math.round(footer.top),
         footerBottom: Math.round(footer.bottom),
         clipped: footer.bottom > window.innerHeight
       };
     })()`,
  );
  log(`settings window: ${JSON.stringify(probe)}`);
  const image = await settingsWindow.webContents.capturePage();
  fs.writeFileSync(OUT, image.toPNG());
  log(`wrote ${OUT}`);
  app.exit(0);
}

async function main() {
  await app.whenReady();
  backgroundManager.install();
  backgroundManager.applyEnvironment();

  if (env('WINDOW', 'app') === 'settings') {
    await captureSettingsWindow();
    return;
  }

  const settingsFile = path.join(SETTINGS_DIR, 'background.json');
  let settings = '（无 background.json，按未设置背景渲染）';
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch {
    log(`no background.json in ${SETTINGS_DIR}`);
  }
  log(`settings: ${JSON.stringify(settings)}`);

  const url = URL_ARG ?? (await startRuntime());
  log(`loading ${url}`);

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
  await new Promise((resolve) => setTimeout(resolve, SETTLE));
  await clickBeforeCapture();

  const probe = await win.webContents.executeJavaScript(
    `(() => {
      const body = getComputedStyle(document.body);
      const token = (name) => body.getPropertyValue(name).trim();
      const fade = document.querySelector('[class*="_fade"]');
      const seat = document.querySelector('[class*="_composerSeat"]');
      return {
        pageDark: document.body.hasAttribute('data-ds-dark-theme'),
        computedScheme: getComputedStyle(document.documentElement).colorScheme,
        // Carries the image's content digest, so it must change with the picture.
        imageUrl: /url\\("([^"]+)"\\)/.exec(body.backgroundImage)?.[1] ?? null,
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

  const image = await win.webContents.capturePage();
  fs.writeFileSync(OUT, image.toPNG());
  log(`wrote ${OUT}`);

  if (child !== null) child.kill();
  app.exit(0);
}

main().catch((error) => {
  log(`FAILED: ${error.stack ?? error.message}`);
  if (child !== null) child.kill();
  app.exit(1);
});
