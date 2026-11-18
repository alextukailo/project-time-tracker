import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const moduleSource = (await readFile(
  new URL('../src/features/google-sheets/api/googleSheetsApi.js', import.meta.url), 'utf8'
)).replace(
  "import { syncSheetData } from './directSheetsSync';",
  'const { syncSheetData } = globalThis.__onboardingMocks;'
).replace(
  "import { extractSpreadsheetId, spreadsheetUrl, verifySpreadsheetAccess } from './sheetsClient';",
  'const { extractSpreadsheetId, spreadsheetUrl, verifySpreadsheetAccess } = globalThis.__onboardingMocks;'
).replace(
  "import { getGoogleAccessToken, signInWithGoogle, signOutFromGoogle } from './oauth';",
  'const { getGoogleAccessToken, signInWithGoogle, signOutFromGoogle } = globalThis.__onboardingMocks;'
);

let storage = {};
let signOutCalls = 0;
const sheetId = 'abcdEFGH0123456789_abcdefghijklmnopqrstuvwxyz';

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        const result = {};
        for (const key of typeof keys === 'string' ? [keys] : keys) {
          if (Object.hasOwn(storage, key)) result[key] = structuredClone(storage[key]);
        }
        return result;
      },
      async set(next) { storage = { ...storage, ...structuredClone(next) }; },
    },
  },
};

globalThis.__onboardingMocks = {
  syncSheetData: async () => { throw new Error('not used in onboarding'); },
  extractSpreadsheetId: (link) => {
    const match = link.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (!match) throw new Error('Неверная ссылка');
    return match[1];
  },
  spreadsheetUrl: (id) => `https://docs.google.com/spreadsheets/d/${id}/edit`,
  verifySpreadsheetAccess: async (id) => ({ id, title: 'Новая таблица' }),
  getGoogleAccessToken: async () => 'test-token',
  signInWithGoogle: async () => true,
  signOutFromGoogle: async () => { signOutCalls++; },
};

const api = await import(`data:text/javascript,${encodeURIComponent(moduleSource)}`);

test('clean install: no linked spreadsheet', async () => {
  storage = {};
  assert.equal(await api.getSyncConfig(), null);
});

test('first spreadsheet connection starts with an empty workspace', async () => {
  storage = {
    projects: [{ id: 'offline-1', name: 'Старый проект', status: 'idle' }],
    timeEntries: [{ id: 'offline-entry' }],
  };
  const connected = await api.connectSpreadsheet(`https://docs.google.com/spreadsheets/d/${sheetId}/edit`);
  assert.equal(connected.spreadsheetId, sheetId);
  assert.equal(connected.spreadsheetTitle, 'Новая таблица');
  assert.deepEqual(storage.projects, []);
  assert.deepEqual(storage.timeEntries, []);
  assert.equal(storage.oauthSpreadsheetProfiles.legacy.projects[0].id, 'offline-1');
});

test('disconnect preserves connected data under spreadsheet ID and returns to setup', async () => {
  storage.projects = [{ id: 'connected-project', status: 'idle' }];
  storage.timeEntries = [{ id: 'connected-entry' }];
  const before = signOutCalls;
  await api.disconnectSpreadsheet();
  assert.equal(await api.getSyncConfig(), null);
  assert.equal(storage.oauthSpreadsheetProfiles[sheetId].projects[0].id, 'connected-project');
  assert.equal(storage.projects[0].id, 'offline-1');
  assert.equal(signOutCalls, before + 1);
});

test('reconnect restores original spreadsheet workspace', async () => {
  await api.connectSpreadsheet(`https://docs.google.com/spreadsheets/d/${sheetId}/edit`);
  assert.equal(storage.projects[0].id, 'connected-project');
  assert.equal(storage.timeEntries[0].id, 'connected-entry');
});

test('active timer blocks disconnect to prevent data loss', async () => {
  storage.projects[0].status = 'running';
  await assert.rejects(api.disconnectSpreadsheet(), /Остановите/);
  assert.equal(storage.selectedSpreadsheetId, sheetId);
});

test('first-run UI gates projects until configuration exists', async () => {
  const tracker = await readFile(new URL('../src/pages/tracker/ui/TrackerPage.jsx', import.meta.url), 'utf8');
  const panel = await readFile(new URL('../src/features/google-sheets/ui/GoogleSheetsPanel.jsx', import.meta.url), 'utf8');
  assert.match(tracker, /!syncConfig\s*\?\s*\(/);
  assert.match(tracker, /onboarding\s*\n/);
  assert.match(panel, /Войти через Google/);
  assert.match(panel, /Ссылка на Google Таблицу/);
  assert.match(panel, /Подключить и начать работу/);
  assert.match(panel, /getGoogleAccessToken\(false\)/);
});
