const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getTasks: () => ipcRenderer.invoke('get-tasks'),
  getTask: (id) => ipcRenderer.invoke('get-task', id),
  createTask: (task) => ipcRenderer.invoke('create-task', task),
  updateTask: (id, task) => ipcRenderer.invoke('update-task', id, task),
  deleteTask: (id) => ipcRenderer.invoke('delete-task', id),
  toggleTask: (id, enabled) => ipcRenderer.invoke('toggle-task', id, enabled),
  syncTask: (id) => ipcRenderer.invoke('sync-task', id),
  testConnection: (config) => ipcRenderer.invoke('test-connection', config),
  getLogs: (taskId) => ipcRenderer.invoke('get-logs', taskId)
});
