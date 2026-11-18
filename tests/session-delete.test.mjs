import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

let storage = {};
globalThis.chrome = {
  storage: { local: {
    async get(keys) {
      const result = {};
      for (const key of typeof keys === 'string' ? [keys] : keys) {
        if (Object.hasOwn(storage, key)) result[key] = structuredClone(storage[key]);
      }
      return result;
    },
    async set(next) { storage = { ...storage, ...structuredClone(next) }; },
  } },
};

const source = await readFile(new URL('../src/entities/time-entry/api/timeEntryStorage.js', import.meta.url), 'utf8');
const timeStorage = await import(`data:text/javascript,${encodeURIComponent(source)}`);
const entry = {
  id: 'entry-1', sessionId: 'session-1', projectId: 'project-1',
  projectName: 'nbd', date: '2026-11-15',
  startedAt: '2026-11-15T11:52:00Z', endedAt: '2026-11-15T11:52:27Z',
  timeZone: 'Europe/Minsk', durationMs: 27000, taskDescription: 'разработка',
  syncStatus: 'synced',
};

test('local session delete saves a remote tombstone with row details', async () => {
  storage = {
    projects: [{ id: 'project-1', name: 'nbd', status: 'idle', totalMs: 27000 }],
    timeEntries: [entry], deletedEntryIds: [], deletedEntryRecords: [],
  };
  const response = await timeStorage.deleteTimeSession('session-1');
  assert.equal(response.deleted, 1);
  assert.equal(storage.timeEntries.length, 0);
  assert.equal(storage.projects[0].totalMs, 0);
  assert.deepEqual(storage.deletedEntryIds, ['entry-1']);
  assert.equal(storage.deletedEntryRecords[0].startedAt, entry.startedAt);
});

test('local deletion handles legacy entries without sessionId', async () => {
  storage = {
    projects: [{ id: 'project-1', name: 'nbd', status: 'idle', totalMs: 27000 }],
    timeEntries: [{ ...entry, sessionId: undefined }],
  };
  const response = await timeStorage.deleteTimeSession('entry-1');
  assert.equal(response.deleted, 1);
  assert.deepEqual(storage.timeEntries, []);
});

const moduleSource = (await readFile(
  new URL('../src/features/google-sheets/api/googleSheetsApi.js', import.meta.url), 'utf8'
))
  .replace("import { syncSheetData } from './directSheetsSync';", "const { syncSheetData } = globalThis.__deletionMocks;")
  .replace("import { extractSpreadsheetId, spreadsheetUrl, verifySpreadsheetAccess } from './sheetsClient';", "const { extractSpreadsheetId, spreadsheetUrl, verifySpreadsheetAccess } = globalThis.__deletionMocks;")
  .replace("import { getGoogleAccessToken, signInWithGoogle, signOutFromGoogle } from './oauth';", "const { getGoogleAccessToken, signInWithGoogle, signOutFromGoogle } = globalThis.__deletionMocks;");
let syncedResponse = null;
globalThis.__deletionMocks = {
  syncSheetData: async (_id, body) => {
    assert.deepEqual(body.deletedEntryIds, ['entry-1']);
    assert.equal(body.deletedEntryRecords[0].id, 'entry-1');
    return structuredClone(syncedResponse);
  },
  spreadsheetUrl: (id) => `https://docs.google.com/spreadsheets/d/${id}/edit`,
};
const syncApi = await import(`data:text/javascript,${encodeURIComponent(moduleSource)}`);

test('remote row remaining in Sheets does not resurrect a deleted session', async () => {
  storage = {
    selectedSpreadsheetId: 'spreadsheet-1',
    selectedSpreadsheetTitle: 'Time Tracker',
    projects: [{ id: 'project-1', name: 'nbd', status: 'idle', syncStatus: 'synced' }],
    timeEntries: [], deletedEntryIds: ['entry-1'], deletedEntryRecords: [entry],
    deletedProjects: [], deletedProjectsHistory: [], dateTabsMigrationV3: true,
  };
  syncedResponse = {
    projects: [{ id: 'project-1', name: 'nbd' }],
    entries: [entry], deletedIds: [], deletedProjectIds: [],
    uploaded: 0, deleted: 0, createdTabs: 0,
  };
  await assert.rejects(syncApi.syncTimeEntries(), /не подтверждено/);
  assert.deepEqual(storage.timeEntries, []);
  assert.deepEqual(storage.deletedEntryIds, ['entry-1']);
  assert.equal(storage.deletedEntryRecords.length, 1);

  syncedResponse = { ...syncedResponse, entries: [], deletedIds: ['entry-1'], deleted: 1 };
  await syncApi.syncTimeEntries();
  assert.deepEqual(storage.timeEntries, []);
  assert.deepEqual(storage.deletedEntryIds, []);
  assert.deepEqual(storage.deletedEntryRecords, []);
});

test('session delete uses inline popup confirmation, not browser window.confirm()', async () => {
  const jsx = await readFile(
    new URL('../src/entities/time-entry/ui/SessionHistory.jsx', import.meta.url), 'utf8'
  );
  assert.match(jsx, /Подтвердить удаление сессии/);
  assert.match(jsx, /Да, удалить/);
  assert.match(jsx, /Отмена/);
  assert.doesNotMatch(jsx, /window\.confirm\s*\(/);
});
