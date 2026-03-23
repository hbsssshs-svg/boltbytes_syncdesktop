const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('conflictDialog', {
  get: (id) => ipcRenderer.invoke('conflict:get', id),
  choose: (id, decision, options) => ipcRenderer.invoke('conflict:choose', id, decision, options || {}),
  openLocal: (id) => ipcRenderer.invoke('conflict:openLocal', id),
  openRemote: (id) => ipcRenderer.invoke('conflict:openRemote', id),
  openBoth: (id) => ipcRenderer.invoke('conflict:openBoth', id),
});
