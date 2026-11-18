import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = (await readFile(new URL('../src/features/google-sheets/api/directSheetsSync.js', import.meta.url), 'utf8'))
  .replace("import { applyRequests, loadSpreadsheet } from './sheetsClient';", `const { loadSpreadsheet, applyRequests } = globalThis.__sheetsMock;`);
globalThis.__sheetsMock = {
  loadSpreadsheet: (...args) => globalThis.__currentMock.loadSpreadsheet(...args),
  applyRequests: (...args) => globalThis.__currentMock.applyRequests(...args),
};
const api = await import(`data:text/javascript,${encodeURIComponent(source)}`);

function createMock() {
  const spreadsheet = {
    properties: { title: 'Time Tracker', timeZone: 'Europe/Minsk', locale: 'ru_RU' },
    sheets: [], developerMetadata: [],
  };
  let nextMetaId = 1;
  const clone = (v) => structuredClone(v);
  const getSheet = (id) => spreadsheet.sheets.find((s) => s.properties.sheetId === id);
  globalThis.__currentMock = {
    loadSpreadsheet: async () => clone(spreadsheet),
    applyRequests: async (_id, requests) => {
      for (const r of requests) {
        if (r.addSheet) {
          spreadsheet.sheets.push({ properties: clone(r.addSheet.properties), data: [{ startRow: 0, rowData: [] }] });
        } else if (r.appendDimension) {
          const g = getSheet(r.appendDimension.sheetId).properties.gridProperties;
          if (r.appendDimension.dimension === 'ROWS') g.rowCount += r.appendDimension.length;
          else g.columnCount += r.appendDimension.length;
        } else if (r.updateCells) {
          const { sheetId, rowIndex, columnIndex } = r.updateCells.start;
          const sheet = getSheet(sheetId);
          const rowData = sheet.data[0].rowData;
          r.updateCells.rows.forEach((record, offset) => {
            const index = rowIndex + offset;
            while (rowData.length <= index) rowData.push({ values: [] });
            record.values.forEach((cell, col) => {
              const dest = columnIndex + col;
              while (rowData[index].values.length <= dest) rowData[index].values.push({});
              const value = cell.userEnteredValue?.stringValue ?? cell.userEnteredValue?.numberValue;
              rowData[index].values[dest] = {
                ...clone(cell), formattedValue: String(value), effectiveValue: clone(cell.userEnteredValue),
              };
            });
          });
        } else if (r.deleteDimension) {
          const { sheetId, startIndex, endIndex } = r.deleteDimension.range;
          const sheet = getSheet(sheetId);
          sheet.data[0].rowData.splice(startIndex, endIndex - startIndex);
          spreadsheet.developerMetadata = spreadsheet.developerMetadata.filter((m) => {
            const range = m.location.dimensionRange;
            return !(range && range.sheetId === sheetId && range.startIndex >= startIndex && range.startIndex < endIndex);
          });
          for (const m of spreadsheet.developerMetadata) {
            const range = m.location.dimensionRange;
            if (range?.sheetId === sheetId && range.startIndex >= endIndex) {
              range.startIndex -= endIndex - startIndex;
              range.endIndex -= endIndex - startIndex;
            }
          }
        } else if (r.createDeveloperMetadata) {
          const meta = clone(r.createDeveloperMetadata.developerMetadata);
          spreadsheet.developerMetadata.push({ ...meta, metadataId: nextMetaId++ });
        } else if (r.updateDeveloperMetadata) {
          const id = r.updateDeveloperMetadata.dataFilters[0].developerMetadataLookup.metadataId;
          const meta = spreadsheet.developerMetadata.find((m) => m.metadataId === id);
          if (meta) meta.metadataValue = r.updateDeveloperMetadata.developerMetadata.metadataValue;
        } else if (r.deleteDeveloperMetadata) {
          const id = r.deleteDeveloperMetadata.dataFilter.developerMetadataLookup.metadataId;
          spreadsheet.developerMetadata = spreadsheet.developerMetadata.filter((m) => m.metadataId !== id);
        }
      }
    },
  };
  return spreadsheet;
}

function data(projects = [], entries = [], deletedEntryIds = [], deletedProjects = []) {
  return { projects, entries, deletedEntryIds, deletedProjects };
}
const project = {
  id: 'project-1', name: 'DeStyle', createdAt: '2026-11-12T09:00:00Z', syncStatus: 'pending',
};
const entry = {
  id: 'entry-1', sessionId: 'session-1', projectId: project.id, projectName: project.name,
  date: '2026-11-12', startedAt: '2026-11-12T06:00:00.000Z', endedAt: '2026-11-12T06:30:00.000Z',
  durationMs: 1800000, timeZone: 'Europe/Minsk', taskDescription: 'Правки главной',
};

test('OAuth direct Sheets: add date tab, 6 columns, decimal hours and no duplicate on retry', async () => {
  const sheet = createMock();
  const first = await api.syncSheetData('sheet-id', data([project], [entry]));
  assert.equal(first.uploaded, 1);
  assert.equal(first.createdTabs, 1);
  assert.equal(first.entries[0].taskDescription, 'Правки главной');
  const tab = sheet.sheets.find((s) => s.properties.title === '12.11.2026');
  assert.ok(tab);
  const row = tab.data[0].rowData[1].values;
  assert.equal(row[4].effectiveValue.numberValue, 0.5);
  assert.equal(row[5].formattedValue, 'Правки главной');
  assert.equal(sheet.developerMetadata.filter((m) => m.metadataKey === 'TRACKER_ENTRY_V3').length, 1);
  const again = await api.syncSheetData('sheet-id', data([project], [entry]));
  assert.equal(again.uploaded, 0);
  assert.equal(again.entries.length, 1);
});

test('OAuth direct Sheets: manually edited description and duration return to client', async () => {
  const sheet = createMock();
  await api.syncSheetData('sheet-id', data([project], [entry]));
  const values = sheet.sheets[0].data[0].rowData[1].values;
  values[3] = { formattedValue: '00:45:00', effectiveValue: { stringValue: '00:45:00' } };
  values[5] = { formattedValue: 'Тестирование', effectiveValue: { stringValue: 'Тестирование' } };
  const result = await api.syncSheetData('sheet-id', data([project]));
  assert.equal(result.entries[0].durationMs, 2700000);
  assert.equal(result.entries[0].taskDescription, 'Тестирование');
  assert.equal(values[4].effectiveValue.numberValue, 0.75);
});

test('OAuth direct Sheets: session deletion removes its row and metadata', async () => {
  const sheet = createMock();
  await api.syncSheetData('sheet-id', data([project], [entry]));
  const result = await api.syncSheetData('sheet-id', data([project], [], ['entry-1']));
  assert.equal(result.entries.length, 0);
  assert.equal(result.deleted, 1);
  assert.equal(sheet.developerMetadata.filter((m) => m.metadataKey === 'TRACKER_ENTRY_V3').length, 0);
});

test('OAuth direct Sheets: rename keeps entry ID and changes visible project name', async () => {
  const sheet = createMock();
  await api.syncSheetData('sheet-id', data([project], [entry]));
  const changed = { ...project, name: 'DeStyle Plus', previousName: 'DeStyle', syncStatus: 'pending' };
  const result = await api.syncSheetData('sheet-id', data([changed]));
  assert.equal(result.projects[0].name, 'DeStyle Plus');
  assert.equal(result.entries[0].id, 'entry-1');
  assert.equal(sheet.sheets[0].data[0].rowData[1].values[0].formattedValue, 'DeStyle Plus');
});

test('OAuth direct Sheets: deleted project cannot reappear from legacy row', async () => {
  const sheet = createMock();
  await api.syncSheetData('sheet-id', data([project], [entry]));
  const tombstone = { id: project.id, name: project.name };
  const result = await api.syncSheetData('sheet-id', data([], [], ['entry-1'], [tombstone]));
  assert.equal(result.projects.length, 0);
  assert.equal(result.entries.length, 0);
  assert.equal(sheet.developerMetadata.length, 0);
});

test('OAuth direct Sheets: manual new row becomes a completed session', async () => {
  const sheet = createMock();
  await api.syncSheetData('sheet-id', data([project]));
  // Simulates a manually entered spreadsheet row in an existing date tab.
  const dateTab = {
    properties: { sheetId: 71, title: '12.11.2026', gridProperties: { rowCount: 100, columnCount: 6 } },
    data: [{ startRow: 0, rowData: [
      { values: ['Проект', 'Начало', 'Конец', 'Длительность', 'Время для трекера', 'Описание задачи'].map((v) => ({ formattedValue: v })) },
      { values: ['DeStyle', '09:00', '09:30', '00:30:00', '', 'Обновил дизайн'].map((v) => ({ formattedValue: v })) },
    ] }],
  };
  sheet.sheets.push(dateTab);
  const result = await api.syncSheetData('sheet-id', data([project]));
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].durationMs, 1800000);
  assert.equal(result.entries[0].taskDescription, 'Обновил дизайн');
  assert.equal(sheet.developerMetadata.filter((m) => m.metadataKey === 'TRACKER_ENTRY_V3').length, 1);
});

test('OAuth direct Sheets: removing a row manually removes entry from the result', async () => {
  const sheet = createMock();
  await api.syncSheetData('sheet-id', data([project], [entry]));
  const tab = sheet.sheets[0];
  tab.data[0].rowData.splice(1, 1);
  sheet.developerMetadata = sheet.developerMetadata.filter((m) => m.metadataKey !== 'TRACKER_ENTRY_V3');
  const result = await api.syncSheetData('sheet-id', data([project]));
  assert.equal(result.entries.length, 0);
});

test('OAuth direct Sheets: delete a session whose row metadata was lost', async () => {
  const sheet = createMock();
  await api.syncSheetData('sheet-id', data([project], [entry]));
  sheet.developerMetadata = sheet.developerMetadata.filter(
    (meta) => meta.metadataKey !== 'TRACKER_ENTRY_V3'
  );
  const result = await api.syncSheetData('sheet-id', {
    ...data([project], [], ['entry-1']),
    deletedEntryRecords: [entry],
  });
  assert.equal(result.deleted, 1);
  assert.deepEqual(result.deletedIds, ['entry-1']);
  assert.equal(result.entries.length, 0);
  assert.equal(sheet.sheets[0].data[0].rowData.length, 1);
});

test('OAuth direct Sheets: refuse ambiguous metadata-free deletion', async () => {
  const sheet = createMock();
  await api.syncSheetData('sheet-id', data([project], [entry]));
  const rows = sheet.sheets[0].data[0].rowData;
  rows.push(structuredClone(rows[1]));
  sheet.developerMetadata = sheet.developerMetadata.filter(
    (meta) => meta.metadataKey !== 'TRACKER_ENTRY_V3'
  );
  await assert.rejects(
    api.syncSheetData('sheet-id', {
      ...data([project], [], ['entry-1']),
      deletedEntryRecords: [entry],
    }),
    /Нельзя однозначно определить/
  );
  assert.equal(rows.length, 3);
});

test('OAuth direct Sheets: server cannot acknowledge a row it did not delete', async () => {
  const sheet = createMock();
  await api.syncSheetData('sheet-id', data([project], [entry]));
  const originalApply = globalThis.__currentMock.applyRequests;
  globalThis.__currentMock.applyRequests = (id, requests) => originalApply(
    id, requests.filter((request) => !request.deleteDimension)
  );
  const result = await api.syncSheetData('sheet-id', {
    ...data([project], [], ['entry-1']),
    deletedEntryRecords: [entry],
  });
  assert.deepEqual(result.deletedIds, []);
  assert.equal(result.entries.length, 1);
  assert.equal(sheet.sheets[0].data[0].rowData.length, 2);
});
