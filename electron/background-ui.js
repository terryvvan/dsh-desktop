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
  dim: document.getElementById('dim'),
  dimValue: document.getElementById('dimValue'),
  clear: document.getElementById('clear'),
  close: document.getElementById('close'),
  notice: document.getElementById('notice'),
};

const percent = (fraction) => `${Math.round(fraction * 100)}%`;

/**
 * Repaint every control from a settings snapshot. Only called for state
 * changes that are not the user dragging — re-rendering a slider mid-drag
 * would fight the pointer.
 * @param {{ enabled: boolean, fileName: string | null, uiOpacity: number, dim: number }} state
 */
function render(state) {
  const hasImage = state.enabled && state.fileName !== null;
  els.fileName.textContent = state.fileName !== null ? state.fileName : '未设置';
  els.fileName.classList.toggle('empty', state.fileName === null);

  els.uiOpacity.value = String(Math.round(state.uiOpacity * 100));
  els.uiValue.textContent = percent(state.uiOpacity);
  els.dim.value = String(Math.round(state.dim * 100));
  els.dimValue.textContent = percent(state.dim);

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
bindSlider(els.dim, els.dimValue, 'dim');

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
