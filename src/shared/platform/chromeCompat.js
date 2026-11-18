/**
 * Stage 1 compatibility adapter: keep the existing React/FSD data layer working
 * without changing its Chrome API imports. This is a deliberately narrow shim.
 * Electron's preload exports only storage methods, not unrestricted ipcRenderer.
 *
 * Stage 2 will extract explicit platform adapters and desktop Google OAuth.
 */
if (window.desktop?.platform === 'electron') {
  document.documentElement.dataset.desktop = 'true';

  const listeners = new Set();
  window.desktop.storage.onChanged((changes) => {
    for (const listener of listeners) {
      listener(changes, 'local');
    }
  });

  globalThis.chrome = {
    storage: {
      local: {
        get: (keys) => window.desktop.storage.get(keys),
        set: (items) => window.desktop.storage.set(items),
        remove: (keys) => window.desktop.storage.remove(keys),
      },
      onChanged: {
        addListener(listener) { listeners.add(listener); },
        removeListener(listener) { listeners.delete(listener); },
      },
    },
  };
}
