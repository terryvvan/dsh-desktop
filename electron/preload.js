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
  /** Open a file picker, copy the choice into the app's own background store. */
  choose: () => ipcRenderer.invoke('dshbg:choose'),
  /**
   * Apply a partial patch: `{ uiOpacity }`, `{ canvasOpacity }`, `{ dim }`,
   * `{ palette }`, `{ enabled }`, or `{ playback: { loop, muted, speed,
   * pauseWhenHidden } }`.
   */
  update: (patch) => ipcRenderer.invoke('dshbg:update', patch),
  /** Turn the background off and delete the copied file. */
  clear: () => ipcRenderer.invoke('dshbg:clear'),
  /**
   * Subscribe to state the main process learns on its own — what the page
   * reports about the current video, mainly. Returns an unsubscribe function.
   */
  onState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('dshbg:state', handler);
    return () => ipcRenderer.removeListener('dshbg:state', handler);
  },
});
