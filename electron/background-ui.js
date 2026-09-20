'use strict';

/**
 * Renderer logic for the background settings window.
 *
 * Talks to the main process only through the functions `preload.js` exposes on
 * `window.dshBackground`, plus the state pushes it subscribes to — the main
 * process learns what the current video is a moment after the player is
 * created, and sends a fresh snapshot when it does.
 *
 * @module desktop/background-ui
 */

const api = window.dshBackground;

const els = {
  fileName: document.getElementById('fileName'),
  fileHint: document.getElementById('fileHint'),
  choose: document.getElementById('choose'),
  videoCard: document.getElementById('videoCard'),
  videoMeta: document.getElementById('videoMeta'),
  videoMuted: document.getElementById('videoMuted'),
  videoSpeed: document.getElementById('videoSpeed'),
  videoSpeedValue: document.getElementById('videoSpeedValue'),
  videoPauseHidden: document.getElementById('videoPauseHidden'),
  videoWarn: document.getElementById('videoWarn'),
  uiOpacity: document.getElementById('uiOpacity'),
  uiValue: document.getElementById('uiValue'),
  canvasOpacity: document.getElementById('canvasOpacity'),
  canvasValue: document.getElementById('canvasValue'),
  dim: document.getElementById('dim'),
  dimValue: document.getElementById('dimValue'),
  palette: document.getElementById('palette'),
  paletteState: document.getElementById('paletteState'),
  paletteWarn: document.getElementById('paletteWarn'),
  clear: document.getElementById('clear'),
  close: document.getElementById('close'),
  notice: document.getElementById('notice'),
};

const percent = (fraction) => `${Math.round(fraction * 100)}%`;

const PALETTE_LABEL = {
  auto: '跟随背景图',
  light: '浅色',
  dark: '深色',
  theme: '跟随 DSH 主题',
};

/** `123.4` reads as `2:03`; `null` (still loading) as a placeholder. */
function duration(seconds) {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

const rate = (speed) => `${speed.toFixed(2)}×`;

/**
 * Everything the palette card shows: which palette is in force, and — if the
 * page's own token sheet could not be read — that the choice cannot be painted.
 * @param {{ palette: string, resolved: 'light' | 'dark' | null, paletteApplied: boolean }} state
 */
function renderPalette(state) {
  els.palette.value = state.palette;
  const label = PALETTE_LABEL[state.palette] ?? state.palette;
  els.paletteState.textContent =
    state.palette === 'auto' && state.resolved !== null
      ? `${label}（${state.resolved === 'dark' ? '深色' : '浅色'}）`
      : label;

  els.paletteWarn.hidden = state.paletteApplied;
  if (!state.paletteApplied) {
    els.paletteWarn.textContent = '读取界面配色令牌失败，暂时只能跟随 DSH 自带主题；重新加载界面（F5）可再试一次。';
  }
}

/**
 * The video card: what the page reported about the file, and the player
 * preferences. Hidden entirely for still and animated images, which have
 * nothing to configure.
 * @param {object} state
 */
function renderVideo(state) {
  const video = state.video === true;
  els.videoCard.hidden = !video;
  if (!video) return;

  const info = state.videoInfo;
  els.videoMeta.textContent =
    info === null
      ? '读取中…'
      : info.error !== null
        ? '无法播放这个文件'
        : `${info.width}×${info.height} · ${duration(info.duration)}`;

  els.videoMuted.checked = state.playback.muted;
  els.videoSpeed.value = String(Math.round(state.playback.speed * 100));
  els.videoSpeedValue.textContent = rate(state.playback.speed);
  els.videoPauseHidden.checked = state.playback.pauseWhenHidden;

  els.videoWarn.hidden = info === null || info.error === null;
  if (info !== null && info.error !== null) {
    els.videoWarn.textContent = `无法播放这个文件（${info.error}），换一个 MP4 或 WebM 试试。`;
  }
}

/**
 * Repaint every control from a settings snapshot. Only called for state
 * changes that are not the user dragging — re-rendering a slider mid-drag
 * would fight the pointer.
 * @param {{ enabled: boolean, fileName: string | null, uiOpacity: number, canvasOpacity: number,
 *   dim: number, palette: string, resolved: 'light' | 'dark' | null, paletteApplied: boolean,
 *   video: boolean, playback: object, videoInfo: object | null }} state
 */
function render(state) {
  const hasFile = state.enabled && state.fileName !== null;
  els.fileName.textContent = state.fileName !== null ? state.fileName : '未设置';
  els.fileName.classList.toggle('empty', state.fileName === null);

  els.uiOpacity.value = String(Math.round(state.uiOpacity * 100));
  els.uiValue.textContent = percent(state.uiOpacity);
  els.canvasOpacity.value = String(Math.round(state.canvasOpacity * 100));
  els.canvasValue.textContent = percent(state.canvasOpacity);
  els.dim.value = String(Math.round(state.dim * 100));
  els.dimValue.textContent = percent(state.dim);

  renderPalette(state);
  renderVideo(state);

  els.clear.disabled = !hasFile;
  els.notice.textContent = hasFile ? '' : '选择图片或视频后滑块才会在窗口中生效';
}

/** Slider movement applies immediately; the main process debounces the disk write. */
function bindSlider(input, valueEl, key) {
  input.addEventListener('input', () => {
    valueEl.textContent = `${input.value}%`;
    void api.update({ [key]: Number(input.value) / 100 });
  });
}

bindSlider(els.uiOpacity, els.uiValue, 'uiOpacity');
bindSlider(els.canvasOpacity, els.canvasValue, 'canvasOpacity');
bindSlider(els.dim, els.dimValue, 'dim');

// The playback rate shares the percentage slider's shape but its own scale: the
// slider is 25..100, the setting is 0.25×..1×, and its label is a rate.
els.videoSpeed.addEventListener('input', () => {
  const speed = Number(els.videoSpeed.value) / 100;
  els.videoSpeedValue.textContent = rate(speed);
  void api.update({ playback: { speed } });
});

for (const [element, key] of [
  [els.videoMuted, 'muted'],
  [els.videoPauseHidden, 'pauseWhenHidden'],
]) {
  element.addEventListener('change', async () => {
    render(await api.update({ playback: { [key]: element.checked } }));
  });
}

els.palette.addEventListener('change', async () => {
  render(await api.update({ palette: els.palette.value }));
});

els.choose.addEventListener('click', async () => {
  els.choose.disabled = true;
  try {
    render(await api.choose());
  } finally {
    els.choose.disabled = false;
  }
});

els.clear.addEventListener('click', async () => {
  render(await api.clear());
});

els.close.addEventListener('click', () => window.close());

// The main process reports video metadata a moment after the player is created,
// and again after a page load; without this the card would stay on "读取中…".
api.onState(render);

void api.get().then(render);
