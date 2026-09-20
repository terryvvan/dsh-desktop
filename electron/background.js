'use strict';

/**
 * Desktop background image, UI translucency, and palette matching.
 *
 * The shell cannot simply give the BrowserWindow a background: the DSH Web GUI
 * paints its own opaque surfaces and would cover it completely. So this module
 * works on the page instead — it serves the chosen image over a privileged
 * `dshbg://` scheme and injects a stylesheet that paints it behind the app and
 * makes the app's own background tokens translucent.
 *
 * Three deliberate choices:
 *
 * - The image is streamed over a custom protocol rather than inlined as base64
 *   into the stylesheet. Wallpapers are routinely several megabytes; base64
 *   inflates them by a third and re-transmits them on every page load, while
 *   `protocol.handle` costs nothing and needs no re-encode.
 *
 * - The protocol handler ignores the request URL and always serves the one
 *   configured file, so it can never be turned into an arbitrary file read.
 *
 * - The interface palette follows the image, and is applied as a token layer
 *   rather than by changing DSH's own theme preference. A translucent light UI
 *   over a dark wallpaper is a milky grey sheet whose dark text no longer
 *   matches what is behind it; the same UI in its dark palette reads as glass.
 *   DSH's palette is a `--dsw-*` token sheet that is already in the document,
 *   so both palettes are read back from it and the wanted one is re-declared on
 *   `body` with `!important` — inline token writes included, since an inline
 *   declaration never beats an important one. Nothing in DSH changes; only the
 *   colors it is painted with.
 *
 * The theme tokens this overrides are defined by DSH's own theme plugin at
 * runtime, without `!important`, so `!important` here wins regardless of
 * insertion order and without touching DSH at all.
 *
 * @module desktop/background
 */

const { BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, protocol } = require('electron');
const { Readable } = require('node:stream');
const { createHash } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

/** Privileged scheme that serves the current background image. */
const SCHEME = 'dshbg';
/** Only this host is served; every other authority is refused. */
const HOST = 'bg';
/**
 * Base URL of the current image. The stylesheet appends the image's own content
 * digest as a query, which is what makes picking a second wallpaper work: the
 * protocol response is cached by URL, so a stable URL would keep serving the
 * first image for the rest of the session (and beyond — the disk cache
 * outlives the app). The handler ignores the path and the query alike.
 */
const IMAGE_URL = `${SCHEME}://${HOST}/current`;

/**
 * The tokens that paint the application's large surfaces, and are therefore the
 * ones that should let the background through. Each entry names the opacity
 * slider that scales it: the canvas is the wallpaper's own window and is far
 * more transparent than the panels.
 *
 * This list is not guesswork. The surfaces were identified by matching live
 * elements against the authored rules (`elementFromPoint` plus a
 * `document.styleSheets` sweep), and the set was then re-checked by grepping
 * every client bundle for rules that paint with a `--dsw-*` token.
 *
 * Deliberately absent, because translucency there costs readability rather than
 * buying anything:
 *
 * - `--dsw-alias-bg-layer-2` / `-layer-3`, `--dsw-specific-menu` — dialogs,
 *   popovers and menus, which must stay legible over whatever is behind them.
 * - `--dsw-alias-interactive-bg-*` — hovers and selection fills.
 * - `--dsw-alias-button-primary-*` — the accent button, whose brand fill is
 *   what makes it read as the primary action.
 * - `--dsw-alias-bg-mask-*` — scrims, which are already translucent by design.
 * - `--dsw-alias-markdown-code-block*` — code blocks, which need contrast.
 *
 * `--dsw-alias-button-elevated-fill` *is* included, although it is a button
 * fill: it backs the sidebar's full-width "new session" card, which is a large
 * surface sitting in the middle of the sidebar. Left opaque it was the single
 * most visible artefact of the translucent UI — a hard white rectangle with a
 * hairline border, plainly out of place against its own translucent sidebar.
 */
const SURFACE_TOKENS = [
  { token: '--dsw-alias-bg-base', alpha: 'canvas' },
  { token: '--dsw-alias-bg-layer-1', alpha: 'panel' },
  { token: '--dsw-alias-bg-module-platform', alpha: 'panel' },
  { token: '--dsw-specific-sidebar-fill', alpha: 'panel' },
  { token: '--dsw-specific-input-major', alpha: 'panel' },
  { token: '--dsw-alias-button-elevated-fill', alpha: 'panel' },
];

/**
 * Alpha bounds for the panels; below this the interface stops being usable. The
 * canvas may go all the way to transparent — it only carries the wallpaper.
 */
const MIN_UI_OPACITY = 0.2;
const MAX_DIM = 0.85;
/**
 * Below this mean luminance the image counts as dark and the interface switches
 * to its dark palette. 0.5 is the midpoint of the 0–1 scale; anything lighter
 * keeps dark text readable on a translucent white panel.
 */
const DARK_LUMINANCE = 0.5;
/** Window base colour while no image is configured (matches the shell's own chrome). */
const DEFAULT_WINDOW_COLOR = '#1b1c1f';

/** `auto` picks by image luminance; `theme` leaves DSH's own choice alone. */
const PALETTES = ['auto', 'theme', 'light', 'dark'];

const DEFAULTS = {
  enabled: false,
  file: null,
  uiOpacity: 0.72,
  canvasOpacity: 0.32,
  dim: 0.25,
  palette: 'auto',
};

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

/**
 * Read DSH's own two palettes back out of the document. The theme plugin ships
 * them as ordinary rules on `body` and `body[data-ds-dark-theme]`, so the
 * values — including the derived gradients, shadows and syntax colors — can be
 * lifted verbatim instead of being copied into this file and going stale.
 *
 * Evaluated in the page; returns `{ light: [[name, value]], dark: [...] }`.
 */
const HARVEST_SCRIPT = `(() => {
  const palettes = { light: [], dark: [] };
  for (const sheet of Array.from(document.styleSheets)) {
    let rules;
    try { rules = Array.from(sheet.cssRules); } catch { continue; }
    for (const rule of rules) {
      const selector = rule.selectorText;
      if (selector !== 'body' && selector !== 'body[data-ds-dark-theme]') continue;
      const bucket = selector === 'body' ? palettes.light : palettes.dark;
      for (const match of rule.cssText.matchAll(/(--dsw-[a-z0-9-]+)\\s*:\\s*([^;{}]+)/g)) {
        bucket.push([match[1], match[2].trim()]);
      }
    }
  }
  return palettes;
})()`;

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Last declaration wins, matching the cascade. */
function tokenValue(declarations, token) {
  let found;
  for (const [name, value] of declarations) {
    if (name === token) found = value;
  }
  return found;
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
  /** Image analysis per `path:mtime:size`, so slider drags never re-decode. */
  const analysisCache = new Map();
  /** DSH's own palettes, read from the page; null until it could be read. */
  let palettes = null;

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
    const number = (value, fallback, min, max) =>
      Number.isFinite(Number(value)) ? clamp(Number(value), min, max) : fallback;
    return {
      enabled: parsed.enabled === true && file !== null,
      file,
      uiOpacity: number(parsed.uiOpacity, DEFAULTS.uiOpacity, MIN_UI_OPACITY, 1),
      canvasOpacity: number(parsed.canvasOpacity, DEFAULTS.canvasOpacity, 0, 1),
      dim: number(parsed.dim, DEFAULTS.dim, 0, MAX_DIM),
      palette: PALETTES.includes(parsed.palette) ? parsed.palette : DEFAULTS.palette,
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

  /**
   * Everything the shell needs to know about the stored image: the mean colour
   * and luminance, measured on a 32px-wide decode rather than the full file,
   * and a digest of its bytes.
   *
   * Cached per file revision, because the sliders re-render the stylesheet
   * continuously and must not re-read a 5 MB wallpaper on every tick.
   *
   * The digest is what the injected `url()` carries. Identity has to come from
   * the bytes: re-picking a wallpaper copies it over the same file name, and
   * Windows' copy preserves the source file's timestamps, so mtime and size
   * are not enough to tell two images apart.
   *
   * @param {string} absolute
   * @returns {{ digest: string, color: string, luminance: number } | null}
   */
  function analyzeImage(absolute) {
    let revision;
    try {
      const stat = fs.statSync(absolute);
      revision = `${absolute}:${stat.mtimeMs}:${stat.size}`;
    } catch {
      return null;
    }
    const cached = analysisCache.get(revision);
    if (cached !== undefined) return cached;

    let result = null;
    try {
      const digest = createHash('sha1').update(fs.readFileSync(absolute)).digest('hex').slice(0, 12);
      // A digest is still worth having when the file cannot be decoded for
      // measurement (the browser may yet render it), so start from a neutral
      // answer and improve it only if the decode works.
      result = { digest, color: DEFAULT_WINDOW_COLOR, luminance: DARK_LUMINANCE };
      const image = nativeImage.createFromPath(absolute);
      if (!image.isEmpty()) {
        const small = image.resize({ width: 32, quality: 'good' });
        const { width, height } = small.getSize();
        const bitmap = small.toBitmap(); // BGRA, premultiplied by alpha.
        const pixels = Math.max(1, width * height);
        let r = 0;
        let g = 0;
        let b = 0;
        let luminance = 0;
        for (let i = 0; i + 3 < bitmap.length; i += 4) {
          const alpha = bitmap[i + 3] / 255;
          if (alpha === 0) continue;
          // Undo premultiplication so a transparent PNG measures its real colour.
          const blue = bitmap[i] / alpha;
          const green = bitmap[i + 1] / alpha;
          const red = bitmap[i + 2] / alpha;
          r += red;
          g += green;
          b += blue;
          luminance += 0.2126 * red + 0.7152 * green + 0.0722 * blue;
        }
        const mean = (value) => Math.round(clamp(value / pixels, 0, 255));
        result = {
          digest,
          color: `#${[mean(r), mean(g), mean(b)].map((v) => v.toString(16).padStart(2, '0')).join('')}`,
          luminance: clamp(luminance / pixels / 255, 0, 1),
        };
      }
    } catch (error) {
      log(`background: failed to analyse image: ${error.message}`);
    }

    analysisCache.set(revision, result);
    return result;
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

  // ─── palette ───────────────────────────────────────────────────────────────

  /**
   * Palette the interface should be painted in.
   * @returns {'light' | 'dark' | null} null means "leave DSH's own choice alone".
   */
  function resolvedPalette() {
    if (settings.palette === 'theme') return null;
    if (settings.palette === 'light' || settings.palette === 'dark') return settings.palette;
    const absolute = settings.enabled ? currentImagePath() : null;
    const analysis = absolute === null ? null : analyzeImage(absolute);
    if (analysis === null) return null;
    return analysis.luminance < DARK_LUMINANCE ? 'dark' : 'light';
  }

  /**
   * Read DSH's palettes out of the page. Re-run on every load, because a
   * plugin hot-reload rebuilds the token sheets.
   * @param {Electron.WebContents} contents
   */
  async function harvestPalettes(contents) {
    if (contents.isDestroyed()) return;
    try {
      const result = await contents.executeJavaScript(HARVEST_SCRIPT, true);
      if (result !== null && typeof result === 'object' && Array.isArray(result.light) && result.light.length > 0) {
        palettes = result;
        log(`background: read ${result.light.length} light / ${result.dark.length} dark tokens from the page`);
      }
    } catch (error) {
      log(`background: failed to read the page palette: ${error.message}`);
    }
  }

  /**
   * Apply everything about the background that is not the injected stylesheet:
   * the palette Electron's own chrome resolves, and the window's base colour
   * (what shows before the page paints). Called on every settings change, at
   * startup, and whenever the main window is (re)created.
   */
  function applyEnvironment() {
    const palette = settings.enabled ? resolvedPalette() : null;
    // DSH resolves its own `system` preference through this, and Electron's
    // window frame, menus and scrollbars read it too. It is only the half of
    // the story that a pinned DSH preference cannot see; the injected token
    // layer covers that half.
    nativeTheme.themeSource = palette ?? 'system';
    const win = getMainWindow();
    if (win === null || win.isDestroyed()) return;
    try {
      win.setBackgroundColor(windowBackground());
    } catch (error) {
      log(`background: failed to set window colour: ${error.message}`);
    }
  }

  /**
   * Base colour for a window hosting the app: the wallpaper's own mean colour,
   * so the first paint and any uncovered edge blend in instead of flashing the
   * shell's dark chrome.
   * @returns {string} CSS colour.
   */
  function windowBackground() {
    const absolute = settings.enabled ? currentImagePath() : null;
    const analysis = absolute === null ? null : analyzeImage(absolute);
    return analysis === null ? DEFAULT_WINDOW_COLOR : analysis.color;
  }

  /**
   * URL of the stored image, tagged with the digest of its bytes.
   *
   * Without the tag the browser would answer every request for the same URL
   * with the bitmap it already has, so choosing a second wallpaper would change
   * the settings file, the palette and the window colour — everything except
   * the picture on screen. The tag is content-derived, so an unchanged image
   * keeps its cache entry and a changed one cannot collide with it.
   *
   * @returns {string}
   */
  function imageUrl() {
    const absolute = settings.enabled ? currentImagePath() : null;
    const analysis = absolute === null ? null : analyzeImage(absolute);
    return analysis === null ? IMAGE_URL : `${IMAGE_URL}?v=${analysis.digest}`;
  }

  // ─── stylesheet ────────────────────────────────────────────────────────────

  /**
   * Turn the authored, opaque value of a surface token into the translucent
   * version of itself. `color-mix` keeps the token's own colour — including
   * whatever it is defined as — instead of this file repeating DSH's palette.
   * @param {string} base - authored value, e.g. `var(--dsw-static-neutral-bluish-00)`.
   * @param {number} alpha
   * @returns {string}
   */
  function translucent(base, alpha) {
    return `color-mix(in srgb, ${base} ${(clamp(alpha, 0, 1) * 100).toFixed(1)}%, transparent)`;
  }

  /** Translucent declarations for one palette. */
  function surfaceDeclarations(key, value) {
    const source = palettes?.[key] ?? [];
    const panel = clamp(value.uiOpacity, MIN_UI_OPACITY, 1);
    const canvas = clamp(value.canvasOpacity, 0, 1);
    const lines = [];
    for (const { token, alpha } of SURFACE_TOKENS) {
      const base = tokenValue(source, token);
      if (base === undefined) continue;
      lines.push(`  ${token}: ${translucent(base, alpha === 'canvas' ? canvas : panel)} !important;`);
    }
    return lines;
  }

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
   * crisp instead of washing out the way a blanket `opacity` would. Text and
   * icons follow the same palette the panels are painted in, so contrast does
   * not depend on what the wallpaper happens to be doing behind any one label.
   *
   * With a palette chosen, the whole palette is re-declared on `body` first, so
   * the app is painted in it whatever theme it believes it is in. The surfaces
   * come last and win for their own tokens.
   *
   * The closing rules repair DSH's own way of fading content out, which shows
   * up as a bright band with hard edges at the bottom of the session list and
   * above the composer: the fade paints the surface colour a second time over
   * the last few pixels, which is invisible on an opaque surface but over a
   * translucent one lands on top of the first coat. Masking fades the content
   * instead of painting over it, which is what the effect was after.
   *
   * @param {typeof DEFAULTS} value - settings to render.
   * @returns {string} CSS text.
   */
  function buildCss(value) {
    const forced = resolvedPalette();
    const forcedDeclarations =
      forced === null
        ? null
        : (palettes?.[forced] ?? []).filter(
            ([name]) => !SURFACE_TOKENS.some((surface) => surface.token === name),
          );
    // Without DSH's own palette there is nothing to paint the other theme with,
    // so fall back to following whatever theme the page applies itself.
    const applyForced = forced !== null && forcedDeclarations !== null && forcedDeclarations.length > 0;

    const surfacesFor = (key) => surfaceDeclarations(key, value).join('\n');

    const paletteLayer = applyForced
      ? `html { color-scheme: ${forced} !important; }
body {
${forcedDeclarations.map(([name, token]) => `  ${name}: ${token} !important;`).join('\n')}
}`
      : '';

    const surfaceLayer = applyForced
      ? `body {
${surfacesFor(forced)}
}`
      : `body {
${surfacesFor('light')}
}
body[data-ds-dark-theme] {
${surfacesFor('dark')}
}`;

    const dim = clamp(value.dim, 0, MAX_DIM).toFixed(3);
    const scrim = `rgba(0, 0, 0, ${dim})`;

    return `/* desktop background — injected by electron/background.js */
body {
  background-image: linear-gradient(${scrim}, ${scrim}), url("${imageUrl()}") !important;
  background-size: cover, cover !important;
  background-position: center center, center center !important;
  background-repeat: no-repeat, no-repeat !important;
  background-attachment: fixed, fixed !important;
  background-color: transparent !important;
}
${paletteLayer}
${surfaceLayer}
/* DSH fades content by painting the surface colour again; over a translucent
   surface that stacks into a visible band, so fade by masking instead. */
[class*="_fade"] { background-image: none !important; }
[class*="_treeBody"] {
  -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 24px), transparent) !important;
  mask-image: linear-gradient(to bottom, #000 calc(100% - 24px), transparent) !important;
}
[class*="_composerSeat"] {
  background-image: none !important;
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
}
`;
  }

  /**
   * Replace the injected stylesheet on one WebContents. Removing the previous
   * key first keeps repeated injection (every load, every slider tick) from
   * stacking rules.
   *
   * @param {Electron.WebContents} contents
   * @param {boolean} [reharvest] - re-read the page palette first; only needed
   *   after a load, when the token sheets may have been rebuilt.
   */
  async function injectInto(contents, reharvest = false) {
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
    if (reharvest || palettes === null) await harvestPalettes(contents);
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
    const enabled = settings.enabled && currentImagePath() !== null;
    const palette = enabled ? resolvedPalette() : null;
    return {
      enabled,
      fileName: settings.file,
      uiOpacity: settings.uiOpacity,
      canvasOpacity: settings.canvasOpacity,
      dim: settings.dim,
      palette: settings.palette,
      resolved: palette,
      // False while the page palette could not be read, which is the one case
      // where the chosen palette cannot be painted.
      paletteApplied: palette === null || (palettes?.[palette] ?? []).length > 0,
    };
  }

  /** Attach the stylesheet lifecycle to a window that hosts the DSH page. */
  function attachWindow(win) {
    target = win;
    // `dom-ready` paints as early as possible; `did-finish-load` covers the
    // case where the app re-renders after its own boot. Injection is
    // idempotent, so running both is safe.
    win.webContents.on('dom-ready', () => void injectInto(win.webContents, true));
    win.webContents.on('did-finish-load', () => void injectInto(win.webContents, true));
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
      // The revision key is mtime + size, and a copy keeps the source's
      // timestamps: drop the old analysis so the new bytes are always measured,
      // never inherited from the image this one replaced.
      analysisCache.clear();
    } catch (error) {
      log(`background: failed to import image: ${error.message}`);
      dialog.showErrorBox('背景设置 — 无法读取图片', `${source}\n\n${error.message}`);
      return publicState();
    }

    settings = { ...settings, enabled: true, file: name };
    saveSettings();
    refresh();
    applyEnvironment();
    notifyChanged();
    log(`background: image set to ${name}`);
    return publicState();
  }

  function updateSettings(patch) {
    const next = { ...settings };
    let enabledChanged = false;
    let paletteChanged = false;
    if (patch !== null && typeof patch === 'object') {
      if (patch.uiOpacity !== undefined) next.uiOpacity = clamp(Number(patch.uiOpacity), MIN_UI_OPACITY, 1);
      if (patch.canvasOpacity !== undefined) next.canvasOpacity = clamp(Number(patch.canvasOpacity), 0, 1);
      if (patch.dim !== undefined) next.dim = clamp(Number(patch.dim), 0, MAX_DIM);
      if (patch.palette !== undefined && PALETTES.includes(patch.palette)) {
        paletteChanged = next.palette !== patch.palette;
        next.palette = patch.palette;
      }
      if (patch.enabled !== undefined) {
        enabledChanged = next.enabled !== (patch.enabled === true);
        next.enabled = patch.enabled === true;
      }
    }
    settings = next;
    // Paint immediately; only the disk write waits for the drag to settle.
    refresh();
    // The palette also moves Electron's own chrome, so only touch it when the
    // choice behind it actually changed.
    if (paletteChanged || enabledChanged) applyEnvironment();
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
    applyEnvironment();
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
      height: 706,
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
    applyEnvironment,
    windowBackground,
    openSettings,
    clearBackground,
    hasBackground: () => settings.enabled && currentImagePath() !== null,
  };
}

module.exports = { createBackgroundManager };
