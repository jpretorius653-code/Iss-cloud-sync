'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('iss', {
  getConfig:  () => ipcRenderer.invoke('get-config'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  setSite:    (s) => ipcRenderer.invoke('set-site', s),
  setFolder:  (f) => ipcRenderer.invoke('set-folder', f),
  syncNow:    () => ipcRenderer.invoke('sync-now'),
  onStatus:   (cb) => ipcRenderer.on('status', (_e, s) => cb(s))
});
