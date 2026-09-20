'use strict';

/**
 * Preload for the background settings window only.
 *
 * The main window does not load a preload at all, so the DSH page — including
 * any third-party plugin running inside it — has no route to these handlers.
 * Everything is exposed through `contextBridge`, so the page sees four plain
 * functions and nothing else.
 *
 * @module desktop/preload
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshBackground', {
  /** Current settings, without any absolute path, plus what the page renders. */
  get: () => ipcRenderer.invoke('dshbg:get'),
  /** Open a file picker, copy the choice into the app's own image store. */
  choose: () => ipcRenderer.invoke('dshbg:choose'),
  /**
   * Apply a partial patch: `{ uiOpacity }`, `{ canvasOpacity }`, `{ dim }`,
   * `{ palette }` or `{ enabled }`.
   */
  update: (patch) => ipcRenderer.invoke('dshbg:update', patch),
  /** Turn the background off and delete the copied image. */
  clear: () => ipcRenderer.invoke('dshbg:clear'),
});
