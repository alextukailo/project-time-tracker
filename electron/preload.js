import { contextBridge, ipcRenderer } from 'electron';

// Explicit, allowlisted IPC: no arbitrary invoke/send in the renderer.
async function call(channel, args) {
  const result = await ipcRenderer.invoke(channel, args);
  if (result && result.ok === false) {
    const error = new Error(result.error || 'Операция не выполнена');
    error.status = result.status;
    throw error;
  }
  return result?.value;
}

contextBridge.exposeInMainWorld('desktop', {
  platform: 'electron',
  storage: {
    get: (keys) => ipcRenderer.invoke('tracker:storage:get', keys),
    set: (items) => ipcRenderer.invoke('tracker:storage:set', items),
    remove: (keys) => ipcRenderer.invoke('tracker:storage:remove', keys),
    onChanged: (callback) => {
      const listener = (_event, changes) => callback(changes);
      ipcRenderer.on('tracker:storage:changed', listener);
      return () => ipcRenderer.removeListener('tracker:storage:changed', listener);
    },
  },
  auth: {
    status: () => call('tracker:auth:status'),
    signIn: () => call('tracker:auth:login'),
    signOut: () => call('tracker:auth:logout'),
  },
  sheets: {
    request: (args) => call('tracker:sheets:request', args),
  },
});
