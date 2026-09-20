'use strict';

/**
 * Renderer logic for the background settings window.
 *
 * Talks to the main process only through the four functions `preload.js`
 * exposes on `window.dshBackground`.
 *
 * @module desktop/background-ui
 */

const api = window.dshBackground;

const els = {
  fileName: document.getElementById('fileName'),
  choose: document.getElementById('choose'),
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
 * Repaint every control from a settings snapshot. Only called for state
 * changes that are not the user dragging — re-rendering a slider mid-drag
 * would fight the pointer.
 * @param {{ enabled: boolean, fileName: string | null, uiOpacity: number, canvasOpacity: number,
 *   dim: number, palette: string, resolved: 'light' | 'dark' | null, paletteApplied: boolean }} state
 */
function render(state) {
  const hasImage = state.enabled && state.fileName !== null;
  els.fileName.textContent = state.fileName !== null ? state.fileName : '未设置';
  els.fileName.classList.toggle('empty', state.fileName === null);

  els.uiOpacity.value = String(Math.round(state.uiOpacity * 100));
  els.uiValue.textContent = percent(state.uiOpacity);
  els.canvasOpacity.value = String(Math.round(state.canvasOpacity * 100));
  els.canvasValue.textContent = percent(state.canvasOpacity);
  els.dim.value = String(Math.round(state.dim * 100));
  els.dimValue.textContent = percent(state.dim);

  renderPalette(state);

  els.clear.disabled = !hasImage;
  els.notice.textContent = hasImage ? '' : '选择一张图片后滑块才会在窗口中生效';
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

void api.get().then(render);
