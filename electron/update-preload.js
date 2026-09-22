'use strict';

/**
 * Preload for the update progress window only.
 *
 * The main window loads no preload at all, so the DSH page — including any
 * third-party plugin running inside it — has no route to these handlers.
 * Everything is exposed through `contextBridge`, so the page sees three plain
 * functions and nothing else.
 *
 * @module desktop/update-preload
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshUpdate', {
  /** Full state snapshot: phase, progress, phase timeline, mirrors, log tail. */
  get: () => ipcRenderer.invoke('dshup:get'),
  /**
   * Ask the main process to do something. Types: `pause`, `resume`, `cancel`,
   * `retry`, `restart`, `mirror` (payload: mirror id), `speedtest`,
   * `open-log`, `close`.
   */
  action: (type, payload) => ipcRenderer.invoke('dshup:action', { type, payload }),
  /** State pushes; returns an unsubscribe function. */
  onState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('dshup:state', handler);
    return () => ipcRenderer.removeListener('dshup:state', handler);
  },
  /** One installer log line at a time; returns an unsubscribe function. */
  onLog: (listener) => {
    const handler = (_event, line) => listener(line);
    ipcRenderer.on('dshup:log', handler);
    return () => ipcRenderer.removeListener('dshup:log', handler);
  },
});
