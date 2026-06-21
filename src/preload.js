'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rd', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (cfg) => ipcRenderer.send('save-config', cfg),
  setActiveLayout: (idx) => ipcRenderer.send('set-active-layout', idx),
  keyAction: (msg) => ipcRenderer.send('key-action', msg),
  scrollBegin: () => ipcRenderer.send('scroll-begin'),
  scroll: (msg) => ipcRenderer.send('scroll', msg),
  tpMove: (dx, dy) => ipcRenderer.send('tp-move', { dx, dy }),
  tpButton: (action, button, clicks) => ipcRenderer.send('tp-button', { action, button, clicks }),
  setClickThrough: (ignore) => ipcRenderer.send('set-click-through', ignore),
  setOverlayBounds: (b) => ipcRenderer.send('set-overlay-bounds', b),
  pickImage: () => ipcRenderer.invoke('pick-image'),
  openEditor: () => ipcRenderer.send('open-editor'),
  hideOverlay: () => ipcRenderer.send('hide-overlay'),
  onConfig: (cb) => ipcRenderer.on('config', (_e, c) => cb(c)),
  onToggleState: (cb) => ipcRenderer.on('toggle-state', (_e, s) => cb(s)),
});
