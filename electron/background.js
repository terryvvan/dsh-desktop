'use strict';

/**
 * Desktop background (image or video), UI translucency, and palette matching.
 *
 * The shell cannot simply give the BrowserWindow a background: the DSH Web GUI
 * paints its own opaque surfaces and would cover it completely. So this module
 * works on the page instead — it serves the chosen file over a privileged
 * `dshbg://` scheme and injects a stylesheet that paints it behind the app and
 * makes the app's own background tokens translucent.
 *
 * Two kinds of background are supported, and they are painted in two different
 * ways because the renderer gives them no choice:
 *
 * - Still and animated images (GIF, animated WebP/AVIF, APNG) are a CSS
 *   `background-image` on `body`. The browser animates them by itself, so
 *   there is nothing to drive and nothing that can stutter.
 * - Video is a `<video>` element in a fixed, full-window backdrop layer. CSS
 *   cannot play a video, and a `poster`-style still would be a different
 *   feature; the element is created once and then left alone, so changing a
 *   slider never restarts playback. The dim scrim moved onto that same
 *   backdrop layer so that one element carries the whole background, and the
 *   two modes end up with identical stacking.
 *
 * Three deliberate choices:
 *
 * - The file is streamed over a custom protocol rather than inlined as base64
 *   into the stylesheet. Wallpapers — and videos even more so — are routinely
 *   several megabytes; base64 inflates them by a third and re-transmits them on
 *   every page load, while `protocol.handle` costs nothing and needs no
 *   re-encode. Video additionally needs byte ranges: a `<video>` seeks by
 *   requesting them, and a handler that answers every request with the whole
 *   file makes seeking silently fail.
 *
 * - The protocol handler ignores the request URL and always serves the one
 *   configured file, so it can never be turned into an arbitrary file read.
 *
 * - The interface palette follows the background, and is applied as a token
 *   layer rather than by changing DSH's own theme preference. A translucent
 *   light UI over a dark wallpaper is a milky grey sheet whose dark text no
 *   longer matches what is behind it; the same UI in its dark palette reads as
 *   glass. DSH's palette is a `--dsw-*` token sheet that is already in the
 *   document, so both palettes are read back from it and the wanted one is
 *   re-declared on `body` with `!important` — inline token writes included,
 *   since an inline declaration never beats an important one. Nothing in DSH
 *   changes; only the colors it is painted with.
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

/** Privileged scheme that serves the current background file. */
const SCHEME = 'dshbg';
/** Only this host is served; every other authority is refused. */
const HOST = 'bg';
/**
 * Base URL of the current file. The player element and the stylesheet append the
 * file's own content digest as a query, which is what makes picking a second
 * wallpaper work: the protocol response is cached by URL, so a stable URL would
 * keep serving the first file for the rest of the session (and beyond — the disk
 * cache outlives the app). The handler ignores the path and the query alike.
 *
 * The digest sits in the URL and *also* on the player as `data-rev`. That is not
 * redundancy: `HTMLMediaElement.src` is resolved to an absolute URL and stored
 * by the page, so comparing only the resolved `src` cannot tell two revisions
 * apart, while `dataset.rev` is always exactly what was written.
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
 *
 * A video measures at exactly this value — see `analyzeImage` — and the
 * comparison is inclusive so that it lands on `dark`, which is the palette that
 * works over unknown moving footage.
 */
const DARK_LUMINANCE = 0.5;
/** Window base colour while no image is configured (matches the shell's own chrome). */
const DEFAULT_WINDOW_COLOR = '#1b1c1f';

/** `auto` picks by background luminance; `theme` leaves DSH's own choice alone. */
const PALETTES = ['auto', 'theme', 'light', 'dark'];

/**
 * Player defaults for a video background. Muted and looping are not really
 * options for a wallpaper — an unmuted video that autoplays is blocked outright
 * by the browser's autoplay policy — but both are persisted so a build that
 * later allows sound does not need a settings migration.
 */
const PLAYBACK_DEFAULTS = { loop: true, muted: true, speed: 1, pauseWhenHidden: false };
/** Slowest playback rate the slider offers; 1× is its fastest. */
const MIN_PLAYBACK_SPEED = 0.25;

const DEFAULTS = {
  enabled: false,
  file: null,
  uiOpacity: 0.72,
  canvasOpacity: 0.32,
  dim: 0.25,
  palette: 'auto',
  playback: { ...PLAYBACK_DEFAULTS },
};

/**
 * Still images, animated images and video are one flat list to the file picker,
 * because the user is choosing a wallpaper rather than a media type. Animated
 * formats need no code: GIF, animated WebP, animated AVIF and APNG are all
 * animated by the browser inside a CSS `background-image` — including when the
 * same image is used twice through `background-size` layers.
 */
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg', 'apng'];
/**
 * Containers Chromium's bundled ffmpeg build plays. `.mkv` and `.mov` (with an
 * H.264 track) are accepted on the same basis: both are Matroska/QuickTime
 * variants of what WebM/MP4 already cover.
 */
const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv'];
/** Extensions chosen in the picker. */
const PICKER_EXTENSIONS = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS];

const MIME_BY_EXTENSION = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.apng': 'image/apng',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
};

/**
 * Id of the injected backdrop layer. Every id the stylesheet sets is prefixed
 * `dshbg-` so that nothing collides with the application's own DOM, and so a
 * sweep for leftovers can find them all.
 */
const PLAYER_ID = 'dshbg-video';
/**
 * Height of the background settings window, in content pixels.
 *
 * Fixed on purpose, and deliberately smaller than the cards need. This window
 * used to measure its content and resize itself to fit — a window whose size
 * depends on its own layout, re-measured and re-applied on every state change,
 * which drifted whenever the two did not agree exactly. It also could not work:
 * on a 150%-scaled 1707x1067 display the work area is about 711 logical pixels,
 * which is less than the cards require.
 *
 * So the size is fixed and the cards scroll inside it (`main` in
 * `background.html`), with the footer outside the scroll area so the buttons
 * stay reachable. This value keeps the footer on screen at that display size.
 */
const SETTINGS_HEIGHT = 660;


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

/** Content type to answer a `dshbg://` request with. */
function mimeType(absolute) {
  return MIME_BY_EXTENSION[path.extname(absolute).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Whether the configured file is played in a `<video>` rather than painted as a
 * CSS background. Decided by extension, because the picker offers the two kinds
 * as one list and this is the only thing that survives a page load without
 * reading the file.
 * @param {string | null} file - stored basename.
 */
function isVideoFile(file) {
  return file !== null && VIDEO_EXTENSIONS.includes(path.extname(file).slice(1).toLowerCase());
}

/**
 * Parse a single-range `Range` header against a known size.
 *
 * Video is the reason this exists: a `<video>` seeks by asking for byte ranges,
 * and a handler that always answers `200` with the whole file costs a full
 * re-download on every seek — and for a background video that is being looped,
 * that is the common case. A malformed or unsatisfiable range answers `null`,
 * which callers turn into `416` rather than a silent fallback to the full body.
 *
 * @param {string | null} header
 * @param {number} size
 * @returns {{ start: number, end: number } | null} inclusive bounds.
 */
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec((header ?? '').trim());
  if (match === null) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;
  let start;
  let end;
  if (rawStart === '') {
    // `bytes=-N` is the last N bytes.
    const length = Number(rawEnd);
    if (length <= 0) return null;
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end };
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
  /** What the page reported about the current video, or null while unknown. */
  let videoInfo = null;
  /** File the reported `videoInfo` belongs to, so a switch invalidates it. */
  let videoInfoFile = null;

  // ─── settings ──────────────────────────────────────────────────────────────

  /**
   * Read the settings file, falling back to defaults for anything missing or
   * malformed. A corrupt file must never stop the shell from starting.
   * @returns {typeof DEFAULTS} normalized settings.
   */
  function readSettings() {
    let parsed = {};
    try {
      const raw = fs.readFileSync(settingsFile, 'utf8');
      // Notepad and PowerShell both like a UTF-8 BOM, and `JSON.parse` refuses
      // one; the file is hand-editable, so strip it rather than fall back to
      // defaults and silently lose the user's settings.
      parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    } catch (error) {
      if (error.code !== 'ENOENT') log(`background: could not read settings: ${error.message}`);
      parsed = {};
    }
    const file = typeof parsed.file === 'string' && /^[^\\/]+$/.test(parsed.file) ? parsed.file : null;
    const number = (value, fallback, min, max) =>
      Number.isFinite(Number(value)) ? clamp(Number(value), min, max) : fallback;
    const playback = parsed.playback !== null && typeof parsed.playback === 'object' ? parsed.playback : {};
    return {
      enabled: parsed.enabled === true && file !== null,
      file,
      uiOpacity: number(parsed.uiOpacity, DEFAULTS.uiOpacity, MIN_UI_OPACITY, 1),
      canvasOpacity: number(parsed.canvasOpacity, DEFAULTS.canvasOpacity, 0, 1),
      dim: number(parsed.dim, DEFAULTS.dim, 0, MAX_DIM),
      palette: PALETTES.includes(parsed.palette) ? parsed.palette : DEFAULTS.palette,
      playback: {
        loop: playback.loop !== false,
        muted: playback.muted !== false,
        speed: number(playback.speed, PLAYBACK_DEFAULTS.speed, MIN_PLAYBACK_SPEED, 1),
        pauseWhenHidden: playback.pauseWhenHidden === true,
      },
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

  // ─── file storage ──────────────────────────────────────────────────────────

  /**
   * Absolute path of the configured file, or null when it is unset or has gone
   * missing. Callers treat null as "no background".
   * @returns {string | null}
   */
  function currentPath() {
    if (settings.file === null) return null;
    const absolute = path.join(imagesDir, settings.file);
    // `file` is validated as a bare basename on read, so this cannot escape
    // imagesDir; the check is kept as defence in depth.
    if (path.dirname(absolute) !== imagesDir) return null;
    return fs.existsSync(absolute) ? absolute : null;
  }

  /** Whether a video is configured *and* its file is still on disk. */
  function hasVideo() {
    return settings.enabled && isVideoFile(settings.file) && currentPath() !== null;
  }

  /**
   * Everything the shell needs to know about the stored file: the mean colour
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
   * A video is never decoded here — `nativeImage` reads stills — so it gets its
   * digest, which is all that matters for caching, plus the neutral colour and
   * luminance that ask for the dark palette. The measurements are left at the
   * neutral value rather than guessed from a frame, and the settings window says
   * so; picking a palette by hand is one click.
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
      const image = isVideoFile(settings.file) ? nativeImage.createEmpty() : nativeImage.createFromPath(absolute);
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
   *
   * A video resolves to `dark`, because nothing here can measure it — see
   * `analyzeImage`. That is the reading which actually works over unknown
   * moving footage: translucent dark glass keeps text legible whatever frame is
   * behind it, while translucent white turns into a milky sheet that fights
   * every bright frame. The user can still pick `light` by hand.
   *
   * @returns {'light' | 'dark' | null} null means "leave DSH's own choice alone".
   */
  function resolvedPalette() {
    if (settings.palette === 'theme') return null;
    if (settings.palette === 'light' || settings.palette === 'dark') return settings.palette;
    const absolute = settings.enabled ? currentPath() : null;
    const analysis = absolute === null ? null : analyzeImage(absolute);
    if (analysis === null) return null;
    return analysis.luminance <= DARK_LUMINANCE ? 'dark' : 'light';
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
   * shell's dark chrome. A video has no measured colour and falls back to the
   * shell's dark chrome, which is the palette a video is painted in anyway.
   * @returns {string} CSS colour.
   */
  function windowBackground() {
    const absolute = settings.enabled ? currentPath() : null;
    const analysis = absolute === null ? null : analyzeImage(absolute);
    return analysis === null ? DEFAULT_WINDOW_COLOR : analysis.color;
  }

  /**
   * URL of the stored file, tagged with the digest of its bytes.
   *
   * Without the tag the browser would answer every request for the same URL
   * with the bitmap it already has, so choosing a second wallpaper would change
   * the settings file, the palette and the window colour — everything except
   * the picture on screen. The tag is content-derived, so an unchanged file
   * keeps its cache entry and a changed one cannot collide with it.
   *
   * @returns {string}
   */
  function fileUrl() {
    const absolute = settings.enabled ? currentPath() : null;
    const analysis = absolute === null ? null : analyzeImage(absolute);
    return analysis === null ? IMAGE_URL : `${IMAGE_URL}?v=${analysis.digest}`;
  }

  /** Digest of the configured file, or null; the player's revision tag. */
  function fileRevision() {
    const absolute = settings.enabled ? currentPath() : null;
    const analysis = absolute === null ? null : analyzeImage(absolute);
    return analysis === null ? null : analysis.digest;
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
   * Both kinds of background are stacked the same way, which is the point of the
   * backdrop layer: one fixed, full-window element at `z-index: -1`, with the dim
   * scrim painted on it, and the application's own surfaces made translucent so
   * it shows through. A negative `z-index` keeps it behind everything the app
   * paints while raising it above the canvas — a `background-image` on `body`
   * would be painted on the canvas, *under* that element, and would disappear
   * the moment a video needed the element.
   *
   * - Image: the layer paints the image itself, with `cover` + `fixed` so it
   *   always fills the window without distortion and stays put while content
   *   scrolls. Animated images need nothing more — the browser runs them.
   * - Video: the layer is empty and the `<video>` child, injected separately,
   *   provides the picture with `object-fit: cover`. The scrim stays on the
   *   layer, over the video.
   *
   * The scrim is drawn as a flat gradient rather than a solid `background-color`
   * so that it composites identically in both modes.
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

    // Only the still/animated case paints anything on the layer; for a video the
    // layer is a plain sheet of scrim over the element the player script adds.
    const backdropPicture = hasVideo() ? '' : `url("${fileUrl()}")`;

    return `/* desktop background — injected by electron/background.js */
#${PLAYER_ID} {
  position: fixed !important;
  inset: 0 !important;
  z-index: -1 !important;
  overflow: hidden !important;
  pointer-events: none !important;
  background-image: linear-gradient(${scrim}, ${scrim})${backdropPicture === '' ? '' : `, ${backdropPicture}`} !important;
  background-size: cover !important;
  background-position: center center !important;
  background-repeat: no-repeat !important;
  background-attachment: fixed !important;
  background-color: transparent !important;
}
/* The picture fills the layer the way cover fills the body: scaled up until
   both dimensions are covered, and centred, so the overflow is cropped evenly
   rather than squashed. */
#${PLAYER_ID} > video {
  position: absolute !important;
  inset: 0 !important;
  width: 100% !important;
  height: 100% !important;
  object-fit: cover !important;
  pointer-events: none !important;
}
/* The application must not paint a surface of its own over the layer. */
body {
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

  // ─── video player ──────────────────────────────────────────────────────────

  /**
   * Script that creates or updates the backdrop layer and, for a video, its
   * `<video>`.
   *
   * Written as one idempotent function so that every path — first inject, a
   * slider tick, a reload, a swap between an image and a video — can run the same
   * code: the elements are reused when they are already correct, which is what
   * keeps playback from restarting every time an opacity slider moves.
   *
   * The layer exists in both modes, because it is what carries the scrim. A
   * `background-image` on `body` would be painted on the canvas, *underneath* the
   * layer, so the dim would sit behind the picture instead of over it.
   *
   * It is also defensive about the page: DSH boots in stages and `document.body`
   * may not exist yet, and the settings are passed in as JSON rather than
   * interpolated, so nothing here can be broken by a file name.
   *
   * @param {object} spec
   * @param {boolean} spec.video - true for a video, false to tear the player down.
   * @param {string | null} spec.url
   * @param {string | null} spec.rev
   * @param {{ loop: boolean, muted: boolean, speed: number, pauseWhenHidden: boolean }} spec.playback
   * @returns {string} JS source for `executeJavaScript`.
   */
  function playerScript(spec) {
    return `(() => {
  const SPEC = ${JSON.stringify(spec)};
  const ID = ${JSON.stringify(PLAYER_ID)};
  if (document.body === null) return { mode: 'deferred' };

  let host = document.getElementById(ID);
  if (host === null) {
    host = document.createElement('div');
    host.id = ID;
    document.body.appendChild(host);
  }

  if (!SPEC.video || SPEC.url === null) {
    // The layer stays: images paint on it through the stylesheet.
    const stale = host.querySelector('video');
    if (stale !== null) {
      stale.pause();
      stale.removeAttribute('src');
      stale.load();
      stale.remove();
    }
    host.removeAttribute('data-rev');
    return { mode: 'backdrop' };
  }

  let video = host.querySelector('video');
  if (video === null) {
    // Muted, looping and inline from the very first frame: an autoplay attempt
    // on an unmuted element is refused outright, and setting muted after the
    // call is too late for it to count as a gesture-free start.
    video = document.createElement('video');
    video.autoplay = true;
    video.muted = SPEC.playback.muted;
    video.setAttribute('playsinline', '');
    video.setAttribute('aria-hidden', 'true');
    host.appendChild(video);
  }

  // A changed revision gets a new URL, both to defeat the response cache and
  // because the old pipeline is holding the old bytes.
  if (host.dataset.rev !== (SPEC.rev ?? '')) {
    host.dataset.rev = SPEC.rev ?? '';
    video.src = SPEC.url;
    video.load();
  }
  video.loop = SPEC.playback.loop;
  video.muted = SPEC.playback.muted;
  // Chromium throws on a rate outside its supported range, and a settings file
  // edited by hand can hold anything.
  try { video.playbackRate = SPEC.playback.speed; } catch { /* keep the default */ }

  // The element is reused across slider ticks, so the opt-in listener is
  // installed once and reads the fresh preference each time it fires. It
  // re-queries the element, so it keeps working if the picture is ever rebuilt.
  if (host.dataset.hooked !== '1') {
    host.dataset.hooked = '1';
    document.addEventListener('visibilitychange', () => {
      if (SPEC.playback.pauseWhenHidden !== true) return;
      const current = document.querySelector('#' + ID + ' > video');
      if (current === null) return;
      if (document.hidden) current.pause();
      else void current.play().catch(() => {});
    });
  }
  if (video.paused) void video.play().catch(() => {});
  return { mode: 'video', rev: host.dataset.rev };
})()`;
  }

  /**
   * Create, update or remove the video player in the page.
   * @param {Electron.WebContents} contents
   */
  async function syncPlayer(contents) {
    if (contents.isDestroyed()) return;
    const want = hasVideo();
    // The sheet is always injected, so the element is always the thing that has
    // to be removed when the background stops being a video.
    const spec = want
      ? { video: true, url: fileUrl(), rev: fileRevision(), playback: settings.playback }
      : { video: false, url: null, rev: null, playback: settings.playback };
    try {
      await contents.executeJavaScript(playerScript(spec), true);
    } catch (error) {
      log(`background: failed to set up the video player: ${error.message}`);
    }
    if (want) void noteVideoInfo(contents);
  }

  /**
   * Ask the page what it makes of the video — size, length, whether it actually
   * started — and forward it to the settings window. The main process cannot
   * read any of this: `nativeImage` only decodes stills.
   * @param {Electron.WebContents} contents
   */
  async function noteVideoInfo(contents) {
    const file = settings.file;
    const script = `(() => {
      const video = document.querySelector('#${PLAYER_ID} > video');
      if (video === null) return null;
      const finite = (value) => (Number.isFinite(value) ? Math.round(value * 100) / 100 : null);
      return {
        width: video.videoWidth,
        height: video.videoHeight,
        duration: finite(video.duration),
        readyState: video.readyState,
        paused: video.paused,
        currentTime: finite(video.currentTime),
        error: video.error === null ? null : (video.error.message || 'code ' + video.error.code)
      };
    })()`;
    const readInfo = async (attempt) => {
      if (contents.isDestroyed()) return;
      try {
        // Metadata may not have arrived yet; `readyState` 1 is HAVE_METADATA.
        const info = await contents.executeJavaScript(script, true);
        if (info === null || (info.readyState ?? 0) < 1) {
          if (attempt > 0) setTimeout(() => void readInfo(attempt - 1), 700);
          return;
        }
        if (file !== settings.file) return;
        videoInfo = info;
        videoInfoFile = file;
        if (info.error !== null) log(`background: video error: ${info.error}`);
        else log(`background: video ${info.width}x${info.height}, ${info.duration ?? '?'}s, paused=${info.paused}`);
        notifySettings();
      } catch {
        /* the page navigated away; the next load reports again */
      }
    };
    await readInfo(4);
  }

  /** Push fresh state into the settings window, if it is open. */
  function notifySettings() {
    if (settingsWindow === null || settingsWindow.isDestroyed()) return;
    settingsWindow.webContents.send('dshbg:state', publicState());
  }


  /**
   * Replace the injected stylesheet on one WebContents. Removing the previous
   * key first keeps repeated injection (every load, every slider tick) from
   * stacking rules.
   *
   * The player follows the stylesheet rather than living inside it, and is
   * reconciled on every call. That is what makes a slider drag cheap for a
   * video: the `<video>` element is already correct, so it is left alone and
   * keeps playing, while only the CSS is replaced.
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
    // A video must be torn down even when the stylesheet is not injected: the
    // element outlives `removeInsertedCSS`, so clearing or losing the file would
    // otherwise leave the last frame playing behind the interface.
    await syncPlayer(contents);
    if (!settings.enabled || currentPath() === null) return;
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

  /**
   * Serve the configured file, and install the settings-window IPC.
   *
   * Stills are answered in one piece, but video needs byte ranges: a `<video>`
   * probes the container by requesting the head, then seeks by requesting
   * windows, and a handler that ignores `Range` and always answers the whole
   * file makes it re-download from zero on every request — for a looping
   * background, continuously. So `206` with `Content-Range` is a requirement
   * here rather than an optimisation.
   */
  function install() {
    protocol.handle(SCHEME, async (request) => {
      let authority = null;
      try {
        authority = new URL(request.url).hostname;
      } catch {
        /* fall through to the refusal below */
      }
      const absolute = authority === HOST ? currentPath() : null;
      if (absolute === null) {
        log(`background: refusing to serve ${request.url}`);
        return new Response('', { status: 404 });
      }

      const type = mimeType(absolute);
      const headers = (extra) => ({
        'content-type': type,
        // The URL carries a content digest, so the body for a given URL can
        // never change: cache it hard, and a slider tick or a reload costs
        // nothing. `immutable` also keeps Chromium from revalidating a
        // mid-playback range request and stalling the decode.
        'cache-control': 'public, max-age=31536000, immutable',
        'accept-ranges': 'bytes',
        ...extra,
      });

      let size;
      try {
        size = fs.statSync(absolute).size;
      } catch (error) {
        log(`background: failed to serve background: ${error.message}`);
        return new Response('', { status: 500 });
      }

      const range = parseRange(request.headers.get('range'), size);
      if (range === null) {
        // A range was asked for and cannot be honoured — the only other case
        // (`parseRange` returning null with no header) is the plain GET below.
        // A slice cannot be invented, so `416` plus the real size is the answer.
        if ((request.headers.get('range') ?? '') !== '') {
          return new Response('', {
            status: 416,
            headers: headers({ 'content-range': `bytes */${size}` }),
          });
        }
        // The whole file, with its length, which is what lets the media element
        // learn the duration.
        const body = Readable.toWeb(fs.createReadStream(absolute));
        return new Response(body, { status: 200, headers: headers({ 'content-length': String(size) }) });
      }

      const body = Readable.toWeb(fs.createReadStream(absolute, { start: range.start, end: range.end }));
      return new Response(body, {
        status: 206,
        headers: headers({
          'content-range': `bytes ${range.start}-${range.end}/${size}`,
          'content-length': String(range.end - range.start + 1),
        }),
      });
    });

    ipcMain.handle('dshbg:get', () => publicState());
    ipcMain.handle('dshbg:choose', () => chooseImage());
    ipcMain.handle('dshbg:update', (_event, patch) => updateSettings(patch));
    ipcMain.handle('dshbg:clear', () => clearBackground());
  }

  /** State the settings window is allowed to see; never an absolute path. */
  function publicState() {
    const enabled = settings.enabled && currentPath() !== null;
    const palette = enabled ? resolvedPalette() : null;
    const video = enabled && isVideoFile(settings.file);
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
      video,
      playback: { ...settings.playback },
      // What the page reported about the video; null until it has been read, and
      // for images, which need no report.
      videoInfo: video && videoInfoFile === settings.file ? videoInfo : null,
    };
  }

  /** Attach the stylesheet and player lifecycle to a window hosting the DSH page. */
  function attachWindow(win) {
    target = win;
    // `dom-ready` paints as early as possible; `did-finish-load` covers the
    // case where the app re-renders after its own boot. Injection is
    // idempotent, so running both is safe — and for a video it is required, as
    // the element has to be rebuilt after every navigation.
    win.webContents.on('dom-ready', () => void injectInto(win.webContents, true));
    win.webContents.on('did-finish-load', () => void injectInto(win.webContents, true));
    // Chromium pauses a background video whenever the page reports itself
    // hidden, and reports it again on restore but does not resume: without this
    // the wallpaper would come back from a minimise as a frozen frame.
    win.on('restore', () => void syncPlayer(win.webContents));
    win.on('focus', () => void syncPlayer(win.webContents));
    win.on('closed', () => {
      if (target === win) target = null;
    });
  }

  // ─── actions ───────────────────────────────────────────────────────────────

  /** Open the picker and copy the choice into the app's own background store. */
  async function chooseImage() {
    const parent = settingsWindow !== null && !settingsWindow.isDestroyed() ? settingsWindow : undefined;
    const result = await dialog.showOpenDialog(parent, {
      title: '选择背景图片或视频',
      properties: ['openFile'],
      filters: [
        { name: '图片与视频', extensions: PICKER_EXTENSIONS },
        { name: '图片（含 GIF 等动图）', extensions: IMAGE_EXTENSIONS },
        { name: '视频', extensions: VIDEO_EXTENSIONS },
      ],
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
      // never inherited from the file this one replaced.
      analysisCache.clear();
    } catch (error) {
      log(`background: failed to import background: ${error.message}`);
      dialog.showErrorBox('背景设置 — 无法读取文件', `${source}\n\n${error.message}`);
      return publicState();
    }

    settings = { ...settings, enabled: true, file: name };
    // A new file never inherits the old one's metadata, even in the unlikely
    // case that the two chose the same name.
    videoInfo = null;
    videoInfoFile = null;
    saveSettings();
    refresh();
    applyEnvironment();
    notifyChanged();
    log(`background: set to ${name}${isVideoFile(name) ? ' (video)' : ''}`);
    return publicState();
  }

  function updateSettings(patch) {
    const next = { ...settings, playback: { ...settings.playback } };
    let enabledChanged = false;
    let paletteChanged = false;
    let playbackChanged = false;
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
      if (patch.playback !== null && typeof patch.playback === 'object') {
        const wanted = patch.playback;
        if (wanted.loop !== undefined) next.playback.loop = wanted.loop === true;
        if (wanted.muted !== undefined) next.playback.muted = wanted.muted === true;
        if (wanted.pauseWhenHidden !== undefined) next.playback.pauseWhenHidden = wanted.pauseWhenHidden === true;
        if (wanted.speed !== undefined) next.playback.speed = clamp(Number(wanted.speed), MIN_PLAYBACK_SPEED, 1);
        playbackChanged = JSON.stringify(next.playback) !== JSON.stringify(settings.playback);
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
    if (playbackChanged) log(`background: playback ${JSON.stringify(settings.playback)}`);
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
      // Fixed, and deliberately not fitted to the content.
      //
      // The height has to work on the smallest display the shell runs on, not
      // just the tallest content: on a 150%-scaled 1707x1067 screen the work
      // area is only ~711 logical pixels, which is less than the cards need.
      // Fitting the window to the content is therefore not possible there — and
      // the version that tried did it by measuring its own layout and writing
      // the result back, which is a feedback path that drifted whenever the two
      // disagreed. So the window is a fixed size and the *cards scroll*; the
      // footer stays put, because the buttons have to remain reachable.
      height: SETTINGS_HEIGHT,
      center: true,
      parent: main !== null && !main.isDestroyed() ? main : undefined,
      // Modal, so the OS owns the foreground handoff. A plain child window left
      // it to chance: closing the dialog handed activation to whatever window
      // was in front before, and Windows refuses to give it back to a process
      // that is not already foreground, so the app sat behind another
      // application for seconds. As a modal child the system restores the owner
      // itself, which is also what a settings dialog should be.
      modal: main !== null && !main.isDestroyed(),
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
      // Bell and braces for the foreground handoff. The dialog is modal, so the
      // system should restore its owner on its own; this covers the case where
      // it does not — the shell was seen sitting behind another application for
      // seconds after the dialog closed, because Windows will not hand
      // activation back to a process that is not already foreground.
      const owner = getMainWindow();
      if (owner === null || owner.isDestroyed() || owner.isMinimized()) return;
      owner.moveTop();
      owner.focus();
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
    hasBackground: () => settings.enabled && currentPath() !== null,
  };
}

module.exports = { createBackgroundManager };
