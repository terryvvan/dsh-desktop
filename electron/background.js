'use strict';

/**
 * Desktop background image + UI opacity.
 *
 * The shell cannot simply give the BrowserWindow a background: the DSH Web GUI
 * paints its own opaque surfaces and would cover it completely. So this module
 * works on the page instead — it serves the chosen image over a privileged
 * `dshbg://` scheme and injects a stylesheet that paints it behind the app and
 * makes the app's own background tokens translucent.
 *
 * Two deliberate choices:
 *
 * - The image is streamed over a custom protocol rather than inlined as base64
 *   into the stylesheet. Wallpapers are routinely several megabytes; base64
 *   inflates them by a third and re-transmits them on every page load, while
 *   `protocol.handle` costs nothing and needs no re-encode.
 *
 * - The protocol handler ignores the request URL and always serves the one
 *   configured file, so it can never be turned into an arbitrary file read.
 *
 * The theme tokens this overrides are defined by DSH's own theme plugin at
 * runtime, without `!important`, so `!important` here wins regardless of
 * insertion order and without touching DSH at all.
 *
 * @module desktop/background
 */

const { BrowserWindow, dialog, ipcMain, protocol } = require('electron');
const { Readable } = require('node:stream');
const path = require('node:path');
const fs = require('node:fs');

/** Privileged scheme that serves the current background image. */
const SCHEME = 'dshbg';
/** Only this host is served; every other authority is refused. */
const HOST = 'bg';
/** Stable URL used by the injected stylesheet. */
const IMAGE_URL = `${SCHEME}://${HOST}/current`;

/**
 * Surface colors the theme builds its backgrounds from: `--dsw-static-neutral-bluish-00`
 * (#ffffff) for the light theme and `-950` (#151517) for the dark one. Only the
 * alpha is ours to add.
 */
const LIGHT_RGB = '255, 255, 255';
const DARK_RGB = '21, 21, 23';

/**
 * The tokens that paint the application's large surfaces, and are therefore the
 * ones that should let the background through.
 *
 * This list is not guesswork: the surfaces were identified by matching live
 * elements against the authored rules (`elementFromPoint` plus a
 * `document.styleSheets` sweep). It is the complete set of tokens backing an
 * area the user reads or types in — the canvas, the panels, the sidebar and the
 * composer.
 *
 * Deliberately absent, because translucency there costs readability rather than
 * buying anything:
 *
 * - `--dsw-alias-bg-layer-2` / `-layer-3`, `--dsw-specific-menu` — dialogs,
 *   popovers and menus, which must stay legible over whatever is behind them.
 * - `--dsw-alias-interactive-bg-*`, `--dsw-alias-button-*-fill` — hovers and
 *   buttons, whose fill is what makes them read as controls.
 * - `--dsw-alias-bg-mask-*` — scrims, which are already translucent by design.
 * - `--dsw-alias-markdown-code-block*` — code blocks, which need contrast.
 */
const SURFACE_TOKENS = [
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-module-platform',
  '--dsw-specific-sidebar-fill',
  '--dsw-specific-input-major',
];

/** Alpha bounds for the UI surfaces; below this the interface stops being usable. */
const MIN_UI_OPACITY = 0.2;
const MAX_DIM = 0.85;

const DEFAULTS = { enabled: false, file: null, uiOpacity: 0.78, dim: 0.25 };

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg'];

const MIME_BY_EXTENSION = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
};

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Create the background manager.
 * @param {object} options
 * @param {string} options.userDataDir - directory holding the settings file and copied images.
 * @param {(message: string) => void} options.log - shell logger.
 * @param {() => (BrowserWindow | null)} options.getMainWindow - current main window accessor.
 * @param {() => void} [options.onChange] - notified whenever the persisted state changes,
 *   so the shell can refresh menu entries that depend on it.
 * @returns the manager API.
 */
function createBackgroundManager({ userDataDir, log, getMainWindow, onChange }) {
  const settingsFile = path.join(userDataDir, 'background.json');
  const imagesDir = path.join(userDataDir, 'backgrounds');

  /** Persisted settings, mutated in memory and flushed on a short debounce. */
  let settings = readSettings();
  /** Window the stylesheet is injected into. */
  let target = null;
  /** insertCSS key per WebContents, so a re-inject replaces rather than stacks. */
  const injected = new WeakMap();
  let settingsWindow = null;
  let saveTimer = null;

  // ─── settings ──────────────────────────────────────────────────────────────

  /**
   * Read the settings file, falling back to defaults for anything missing or
   * malformed. A corrupt file must never stop the shell from starting.
   * @returns {typeof DEFAULTS} normalized settings.
   */
  function readSettings() {
    let parsed = {};
    try {
      parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    } catch {
      parsed = {};
    }
    const file = typeof parsed.file === 'string' && /^[^\\/]+$/.test(parsed.file) ? parsed.file : null;
    return {
      enabled: parsed.enabled === true && file !== null,
      file,
      uiOpacity: Number.isFinite(Number(parsed.uiOpacity))
        ? clamp(Number(parsed.uiOpacity), MIN_UI_OPACITY, 1)
        : DEFAULTS.uiOpacity,
      dim: Number.isFinite(Number(parsed.dim)) ? clamp(Number(parsed.dim), 0, MAX_DIM) : DEFAULTS.dim,
    };
  }

  /** Flush settings to disk. Slider drags call this only after they settle. */
  function saveSettings() {
    try {
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    } catch (error) {
      log(`background: failed to save settings: ${error.message}`);
    }
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveSettings();
    }, 300);
  }

  // ─── image storage ─────────────────────────────────────────────────────────

  /**
   * Absolute path of the configured image, or null when it is unset or has
   * gone missing. Callers treat null as "no background".
   * @returns {string | null}
   */
  function currentImagePath() {
    if (settings.file === null) return null;
    const absolute = path.join(imagesDir, settings.file);
    // `file` is validated as a bare basename on read, so this cannot escape
    // imagesDir; the check is kept as defence in depth.
    if (path.dirname(absolute) !== imagesDir) return null;
    return fs.existsSync(absolute) ? absolute : null;
  }

  /** Remove every `current.*` copy except the one being kept. */
  function pruneOldCopies(keep) {
    let names;
    try {
      names = fs.readdirSync(imagesDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === keep || !name.startsWith('current.')) continue;
      try {
        fs.unlinkSync(path.join(imagesDir, name));
      } catch {
        /* a stale copy is harmless */
      }
    }
  }

  // ─── stylesheet ────────────────────────────────────────────────────────────

  /**
   * Build the stylesheet injected into the DSH page.
   *
   * The image is painted on `body` with `cover` + `fixed` so it always fills the
   * window without distortion and stays put while content scrolls. The scrim is
   * a second background layer rather than an extra element, which avoids
   * fighting the application's stacking contexts.
   *
   * Surfaces are made translucent by overriding the theme's own background
   * tokens; text and icons keep their full opacity, so the interface stays
   * crisp instead of washing out the way a blanket `opacity` would. The set of
   * overridden tokens is {@link SURFACE_TOKENS}; every other token keeps the
   * color the theme authored.
   *
   * @param {typeof DEFAULTS} value - settings to render.
   * @returns {string} CSS text.
   */
  function buildCss(value) {
    const alpha = clamp(value.uiOpacity, MIN_UI_OPACITY, 1).toFixed(3);
    const dim = clamp(value.dim, 0, MAX_DIM).toFixed(3);
    const scrim = `rgba(0, 0, 0, ${dim})`;
    const surfaces = (rgb) =>
      SURFACE_TOKENS.map((token) => `  ${token}: rgba(${rgb}, ${alpha}) !important;`).join('\n');

    return `/* desktop background — injected by electron/background.js */
body {
  background-image: linear-gradient(${scrim}, ${scrim}), url("${IMAGE_URL}") !important;
  background-size: cover, cover !important;
  background-position: center center, center center !important;
  background-repeat: no-repeat, no-repeat !important;
  background-attachment: fixed, fixed !important;
  background-color: transparent !important;
${surfaces(LIGHT_RGB)}
}
body[data-ds-dark-theme] {
${surfaces(DARK_RGB)}
}
`;
  }

  /**
   * Replace the injected stylesheet on one WebContents. Removing the previous
   * key first keeps repeated injection (every load, every slider tick) from
   * stacking rules.
   * @param {Electron.WebContents} contents
   */
  async function injectInto(contents) {
    if (contents.isDestroyed()) return;
    const previous = injected.get(contents);
    injected.delete(contents);
    if (previous !== undefined) {
      try {
        await contents.removeInsertedCSS(previous);
      } catch {
        /* the page may have navigated away; nothing to clean up */
      }
    }
    if (!settings.enabled || currentImagePath() === null) return;
    try {
      injected.set(contents, await contents.insertCSS(buildCss(settings)));
    } catch (error) {
      log(`background: failed to inject stylesheet: ${error.message}`);
    }
  }

  /** Re-apply the stylesheet to the main window. */
  function refresh() {
    if (target === null || target.isDestroyed()) return;
    void injectInto(target.webContents);
  }

  /** Tell the shell the persisted state moved, so dependent menu items repaint. */
  function notifyChanged() {
    if (typeof onChange === 'function') onChange();
  }

  // ─── public surface ────────────────────────────────────────────────────────

  /**
   * Register the privileged scheme. Must run before the app is ready, so the
   * shell calls this at module load.
   */
  function registerScheme() {
    protocol.registerSchemesAsPrivileged([
      {
        scheme: SCHEME,
        privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
      },
    ]);
  }

  /** Serve the configured image, and install the settings-window IPC. */
  function install() {
    protocol.handle(SCHEME, async (request) => {
      let authority = null;
      try {
        authority = new URL(request.url).hostname;
      } catch {
        /* fall through to the refusal below */
      }
      const absolute = authority === HOST ? currentImagePath() : null;
      if (absolute === null) return new Response('', { status: 404 });
      try {
        const type = MIME_BY_EXTENSION[path.extname(absolute).toLowerCase()] ?? 'application/octet-stream';
        const body = Readable.toWeb(fs.createReadStream(absolute));
        return new Response(body, { headers: { 'content-type': type } });
      } catch (error) {
        log(`background: failed to serve image: ${error.message}`);
        return new Response('', { status: 500 });
      }
    });

    ipcMain.handle('dshbg:get', () => publicState());
    ipcMain.handle('dshbg:choose', () => chooseImage());
    ipcMain.handle('dshbg:update', (_event, patch) => updateSettings(patch));
    ipcMain.handle('dshbg:clear', () => clearBackground());
  }

  /** State the settings window is allowed to see; never an absolute path. */
  function publicState() {
    return {
      enabled: settings.enabled && currentImagePath() !== null,
      fileName: settings.file,
      uiOpacity: settings.uiOpacity,
      dim: settings.dim,
    };
  }

  /** Attach the stylesheet lifecycle to a window that hosts the DSH page. */
  function attachWindow(win) {
    target = win;
    // `dom-ready` paints as early as possible; `did-finish-load` covers the
    // case where the app re-renders after its own boot. Injection is
    // idempotent, so running both is safe.
    win.webContents.on('dom-ready', () => void injectInto(win.webContents));
    win.webContents.on('did-finish-load', () => void injectInto(win.webContents));
    win.on('closed', () => {
      if (target === win) target = null;
    });
  }

  // ─── actions ───────────────────────────────────────────────────────────────

  async function chooseImage() {
    const parent = settingsWindow !== null && !settingsWindow.isDestroyed() ? settingsWindow : undefined;
    const result = await dialog.showOpenDialog(parent, {
      title: '选择背景图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: IMAGE_EXTENSIONS }],
    });
    if (result.canceled || result.filePaths.length === 0) return publicState();

    const source = result.filePaths[0];
    const extension = path.extname(source).toLowerCase();
    const name = `current${extension}`;
    try {
      fs.mkdirSync(imagesDir, { recursive: true });
      // Copy rather than reference: a referenced original that the user later
      // moves or deletes would silently blank the background.
      fs.copyFileSync(source, path.join(imagesDir, name));
      pruneOldCopies(name);
    } catch (error) {
      log(`background: failed to import image: ${error.message}`);
      dialog.showErrorBox('背景设置 — 无法读取图片', `${source}\n\n${error.message}`);
      return publicState();
    }

    settings = { ...settings, enabled: true, file: name };
    saveSettings();
    refresh();
    notifyChanged();
    log(`background: image set to ${name}`);
    return publicState();
  }

  function updateSettings(patch) {
    const next = { ...settings };
    let enabledChanged = false;
    if (patch !== null && typeof patch === 'object') {
      if (patch.uiOpacity !== undefined) next.uiOpacity = clamp(Number(patch.uiOpacity), MIN_UI_OPACITY, 1);
      if (patch.dim !== undefined) next.dim = clamp(Number(patch.dim), 0, MAX_DIM);
      if (patch.enabled !== undefined) {
        enabledChanged = next.enabled !== (patch.enabled === true);
        next.enabled = patch.enabled === true;
      }
    }
    settings = next;
    // Paint immediately; only the disk write waits for the drag to settle.
    refresh();
    scheduleSave();
    // Slider drags fire continuously and cannot change `hasBackground`, so the
    // menu is only rebuilt when the toggle actually moves.
    if (enabledChanged) notifyChanged();
    return publicState();
  }

  function clearBackground() {
    settings = { ...settings, enabled: false, file: null };
    clearTimeout(saveTimer);
    saveTimer = null;
    saveSettings();
    pruneOldCopies(null);
    refresh();
    notifyChanged();
    log('background: cleared');
    return publicState();
  }

  /** Open the settings window, or focus the one already open. */
  function openSettings() {
    if (settingsWindow !== null && !settingsWindow.isDestroyed()) {
      settingsWindow.show();
      settingsWindow.focus();
      return;
    }
    const main = getMainWindow();
    settingsWindow = new BrowserWindow({
      width: 470,
      height: 520,
      parent: main !== null && !main.isDestroyed() ? main : undefined,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: '背景设置',
      backgroundColor: '#1b1c1f',
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        preload: path.join(__dirname, 'preload.js'),
      },
    });
    settingsWindow.loadFile(path.join(__dirname, 'background.html'));
    settingsWindow.once('ready-to-show', () => settingsWindow?.show());
    settingsWindow.on('closed', () => {
      settingsWindow = null;
    });
  }

  return {
    registerScheme,
    install,
    attachWindow,
    refresh,
    openSettings,
    clearBackground,
    hasBackground: () => settings.enabled && currentImagePath() !== null,
  };
}

module.exports = { createBackgroundManager };
