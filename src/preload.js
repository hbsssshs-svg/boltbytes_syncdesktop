const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopSync', {
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: config => ipcRenderer.invoke('config:save', config),
  getDefaultVirtualFilesFolder: () => ipcRenderer.invoke('config:getDefaultVirtualFilesFolder'),
  getCacheInfo: () => ipcRenderer.invoke('cache:info'),
  runCacheCleanup: () => ipcRenderer.invoke('cache:cleanup'),
  getVfsStatus: () => ipcRenderer.invoke('vfs:status'),
  login: config => ipcRenderer.invoke('auth:login', config),
  logout: config => ipcRenderer.invoke('auth:logout', config),
  runSync: config => ipcRenderer.invoke('sync:run', config),
  onSyncLive: (callback) => {
    const handler = (_, payload) => callback(payload);
    ipcRenderer.on('sync:live', handler);
    return () => ipcRenderer.removeListener('sync:live', handler);
  },
  togglePauseSync: (config) => ipcRenderer.invoke('sync:togglePause', config),
  listRemoteFolderTreePaths: (config) => ipcRenderer.invoke('remoteFolders:listTreePaths', config),
  listRemoteFolders: config => ipcRenderer.invoke('remoteFolders:list', config),
  listRemoteFolderChildren: (config, parentId) => ipcRenderer.invoke('remoteFolders:listChildren', config, parentId),
  createRemoteFolder: (config, parentId, folderName) => ipcRenderer.invoke('remoteFolders:createFolder', config, parentId, folderName),
  listTrash: config => ipcRenderer.invoke('trash:list', config),
  restoreTrashEntries: (config, entryIds) => ipcRenderer.invoke('trash:restore', config, entryIds),
  deleteTrashEntries: (config, entryIds) => ipcRenderer.invoke('trash:deletePermanent', config, entryIds),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  openLocalFolder: config => ipcRenderer.invoke('shell:openLocalFolder', config),
  openPath: targetPath => ipcRenderer.invoke('shell:openPath', targetPath),
  createExplorerShortcut: config => ipcRenderer.invoke('explorerShortcut:create', config),
  removeExplorerShortcut: config => ipcRenderer.invoke('explorerShortcut:remove', config),
  getExplorerShortcutStatus: config => ipcRenderer.invoke('explorerShortcut:status', config),
  onActivity: callback => {
    const handler = (_, payload) => callback(payload);
    ipcRenderer.on('activity:push', handler);
    return () => ipcRenderer.removeListener('activity:push', handler);
  },
  onStatus: callback => {
    const handler = (_, payload) => callback(payload);
    ipcRenderer.on('status:update', handler);
    return () => ipcRenderer.removeListener('status:update', handler);
  },

  onVfsStatus: callback => {
    const handler = (_, payload) => callback(payload);
    ipcRenderer.on('vfs:status', handler);
    return () => ipcRenderer.removeListener('vfs:status', handler);
  },

  onApiDebug: callback => {
    const handler = (_, payload) => callback(payload);
    ipcRenderer.on('debug:api', handler);
    return () => ipcRenderer.removeListener('debug:api', handler);
  },

});