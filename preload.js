// Gives the page the few main-process services it needs, and nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wordnet', {
  lookup: (word) => ipcRenderer.invoke('wordnet:lookup', word),
});

contextBridge.exposeInMainWorld('files', {
  open: () => ipcRenderer.invoke('file:open'),
  save: (bytes, options) => ipcRenderer.invoke('file:save', bytes, options),
  confirmDiscard: (name) => ipcRenderer.invoke('file:confirm-discard', name),
  setDirty: (dirty) => ipcRenderer.send('file:set-dirty', dirty),
  onCloseRequested: (callback) => ipcRenderer.on('app:close-requested', () => callback()),
  close: () => ipcRenderer.send('app:close'),
});
