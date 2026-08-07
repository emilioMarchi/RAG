const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close:    () => ipcRenderer.invoke('window:close'),

  // File dialog
  openFile: () => ipcRenderer.invoke('dialog:openFile'),

  // Backend URL
  getBackendUrl: () => ipcRenderer.invoke('backend:url'),
});
