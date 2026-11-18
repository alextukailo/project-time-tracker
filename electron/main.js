import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createStorage } from './storage.js';
import { createDesktopOAuth } from './oauth-core.js';
import { desktopClientId } from './oauth-config.js';
import { desktopClientSecret } from './oauth-client-secret.js';
import { createSheetsService } from './sheets-service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let mainWindow;
let storage;
let oauth;
let sheets;

function checkSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error('Запрос отклонён: неизвестное окно');
  }
}

function openAllowedExternal(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' &&
        (parsed.hostname === 'docs.google.com' || parsed.hostname === 'sheets.new')) {
      void shell.openExternal(url);
    }
  } catch {
    // Ignore invalid or unsupported destinations.
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 520,
    height: 800,
    minWidth: 420,
    minHeight: 520,
    title: 'Time Tracker',
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(here, 'preload.mjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  mainWindow = win;

  win.webContents.setWindowOpenHandler(({ url }) => {
    openAllowedExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    const dev = process.env.VITE_DEV_SERVER_URL;
    const expected = dev ? new URL(dev).origin : new URL(`file://${path.join(app.getAppPath(), 'dist-desktop/index.html')}`).href;
    if ((dev && new URL(url).origin !== expected) || (!dev && url !== expected)) {
      event.preventDefault();
      openAllowedExternal(url);
    }
  });

  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) {
    void win.loadURL(devServer);
  } else {
    void win.loadFile(path.join(app.getAppPath(), 'dist-desktop/index.html'));
  }
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
}

app.whenReady().then(() => {
  storage = createStorage(path.join(app.getPath('userData'), 'tracker-data.json'), (changes) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tracker:storage:changed', changes);
    }
  });
  ipcMain.handle('tracker:storage:get', (event, keys) => {
    checkSender(event);
    return storage.get(keys);
  });
  ipcMain.handle('tracker:storage:set', (event, values) => {
    checkSender(event);
    return storage.set(values);
  });
  ipcMain.handle('tracker:storage:remove', (event, keys) => {
    checkSender(event);
    return storage.remove(keys);
  });
  oauth = createDesktopOAuth({
    clientId: desktopClientId,
    clientSecret: desktopClientSecret,
    tokenFile: path.join(app.getPath('userData'), 'google-oauth.enc'),
    safeStorage,
    shell,
  });
  sheets = createSheetsService({ auth: oauth });
  const handle = (channel, callback) => {
    ipcMain.handle(channel, async (event, args) => {
      checkSender(event);
      try {
        return { ok: true, value: await callback(args) };
      } catch (error) {
        // Only known values cross the IPC boundary; never include token or headers.
        return { ok: false, error: error.message, status: error.status ?? null };
      }
    });
  };
  handle('tracker:auth:status', () => oauth.status());
  handle('tracker:auth:login', () => oauth.login());
  handle('tracker:auth:logout', () => oauth.logout());
  handle('tracker:sheets:request', (args) => sheets.request(args));
  createWindow();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
