
import { applyRequests, loadSpreadsheet } from './sheetsClient';

const HEADERS = [
  'Проект', 'Начало', 'Конец', 'Длительность',
  'Время для трекера', 'Описание задачи',
];
const PROJECT_META = 'TRACKER_PROJECT_V3';
const ROW_META = 'TRACKER_ENTRY_V3';
const DATE_RE = /^(\d{2})\.(\d{2})\.(\d{4})$/;
const normalize = (value) => String(value ?? '').trim().toLocaleLowerCase('ru');
const nowIso = () => new Date().toISOString();
const randomId = () => crypto.randomUUID();

function parseJson(value) {
  try { return JSON.parse(value ?? ''); } catch { return null; }
}

function getMeta(data, key) {
  return (data.developerMetadata ?? []).filter((item) => item.metadataKey === key);
}

function existingProjects(data) {
  return getMeta(data, PROJECT_META)
    .map((meta) => ({ ...parseJson(meta.metadataValue), metadataId: meta.metadataId }))
    .filter((project) => project.id && project.name);
}

function sheetDate(title) {
  const match = title?.match(DATE_RE);
  if (!match) return null;
  const [, day, month, year] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return null;
  return `${year}-${month}-${day}`;
}

function tabTitle(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Некорректная дата сессии');
  const [year, month, day] = date.split('-');
  const title = `${day}.${month}.${year}`;
  if (sheetDate(title) !== date) throw new Error('Некорректная дата сессии');
  return title;
}

function readCells(sheet) {
  const grid = sheet.data?.[0];
  const startRow = grid?.startRow ?? 0;
  return (grid?.rowData ?? []).map((record, index) => ({
    index: index + startRow,
    values: Array.from({ length: 6 }, (_, column) => {
      const cell = record.values?.[column];
      return String(cell?.formattedValue ?? cell?.effectiveValue?.stringValue ??
        cell?.effectiveValue?.numberValue ?? cell?.userEnteredValue?.stringValue ?? '').trim();
    }),
  }));
}

function readDateSheets(data) {
  const metas = getMeta(data, ROW_META);
  const byRow = new Map();
  for (const meta of metas) {
    const range = meta.location?.dimensionRange;
    if (!range || range.dimension !== 'ROWS') continue;
    byRow.set(`${range.sheetId}:${range.startIndex}`, meta);
  }
  const result = [];
  for (const sheet of data.sheets ?? []) {
    const date = sheetDate(sheet.properties?.title);
    if (!date) continue;
    const cells = readCells(sheet);
    const headings = cells.find((item) => item.index === 0)?.values ?? [];
    if (headings.some(Boolean) && !HEADERS.slice(0, 4).every((h, i) => headings[i] === h)) {
      throw new Error(`Неверные заголовки листа «${sheet.properties.title}»`);
    }
    for (const record of cells) {
      if (record.index === 0 || !record.values.some(Boolean)) continue;
      const meta = byRow.get(`${sheet.properties.sheetId}:${record.index}`);
      result.push({ sheet, date, ...record, meta, stored: parseJson(meta?.metadataValue) });
    }
  }
  return result;
}

function metadataCreate(key, value, location) {
  return {
    createDeveloperMetadata: {
      developerMetadata: {
        metadataKey: key,
        metadataValue: JSON.stringify(value),
        location,
        visibility: 'DOCUMENT',
      },
    },
  };
}

function metadataUpdate(metadataId, value) {
  return {
    updateDeveloperMetadata: {
      dataFilters: [{ developerMetadataLookup: { metadataId } }],
      developerMetadata: { metadataValue: JSON.stringify(value) },
      fields: 'metadataValue',
    },
  };
}

function metadataDelete(metadataId) {
  return {
    deleteDeveloperMetadata: {
      dataFilter: { developerMetadataLookup: { metadataId } },
    },
  };
}

function safeText(value) {
  // Sending stringValue rather than USER_ENTERED prevents formula injection.
  return String(value ?? '').slice(0, 500);
}

function singleCell(sheetId, rowIndex, columnIndex, value) {
  return {
    updateCells: {
      start: { sheetId, rowIndex, columnIndex },
      rows: [{ values: [{ userEnteredValue: typeof value === 'number' ? { numberValue: value } : { stringValue: safeText(value) } }] }],
      fields: 'userEnteredValue',
    },
  };
}

function writeCells(sheetId, rowIndex, values) {
  return {
    updateCells: {
      start: { sheetId, rowIndex, columnIndex: 0 },
      rows: [{ values: values.map((value) => ({
        userEnteredValue: typeof value === 'number' ? { numberValue: value } : { stringValue: safeText(value) },
      })) }],
      fields: 'userEnteredValue',
    },
  };
}

function headerRequests(sheet) {
  const id = sheet.properties.sheetId;
  const columnCount = sheet.properties.gridProperties?.columnCount ?? 26;
  const requests = [];
  if (columnCount < 6) {
    requests.push({ appendDimension: { sheetId: id, dimension: 'COLUMNS', length: 6 - columnCount } });
  }
  requests.push(writeCells(id, 0, HEADERS));
  requests.push({ updateSheetProperties: {
    properties: { sheetId: id, gridProperties: { frozenRowCount: 1 } },
    fields: 'gridProperties.frozenRowCount',
  } });
  requests.push({ repeatCell: {
    range: { sheetId: id, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 6 },
    cell: { userEnteredFormat: {
      backgroundColor: { red: 0.945, green: 0.737, blue: 0 },
      textFormat: { foregroundColor: { red: 0, green: 0, blue: 0 }, bold: true },
    } },
    fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat',
  } });
  return requests;
}

function addDateSheetRequests(sheetId, title) {
  const sheet = { properties: { sheetId, title, gridProperties: { rowCount: 100, columnCount: 6 } } };
  return [
    { addSheet: { properties: sheet.properties } },
    ...headerRequests(sheet),
  ];
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60]
    .map((value) => String(value).padStart(2, '0')).join(':');
}

function parseDuration(value) {
  const match = String(value).match(/^(\d+):(\d{2}):(\d{2})$/);
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) {
    throw new Error(`Неверная длительность: ${value}. Используйте ЧЧ:ММ:СС`);
  }
  return (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000;
}

const formatters = new Map();
function partsFor(iso, zone) {
  if (!formatters.has(zone)) {
    formatters.set(zone, new Intl.DateTimeFormat('en-GB', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  const parts = Object.fromEntries(formatters.get(zone).formatToParts(new Date(iso))
    .filter((part) => part.type !== 'literal').map(({ type, value }) => [type, value]));
  return parts;
}

function timeFor(iso, zone, entryDate, isEnd) {
  const parts = partsFor(iso, zone);
  const clock = `${parts.hour}:${parts.minute}:${parts.second}`;
  const actualDate = `${parts.year}-${parts.month}-${parts.day}`;
  return isEnd && clock === '00:00:00' && actualDate !== entryDate ? '24:00:00' : clock;
}

function parseClock(value, isEnd) {
  const match = String(value).match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) throw new Error(`Неверное время: ${value}`);
  const [h, m, s] = match.slice(1).map((n) => Number(n ?? 0));
  if (h > 24 || m > 59 || s > 59 || (h === 24 && (!isEnd || m || s))) {
    throw new Error(`Неверное время: ${value}`);
  }
  return [h, m, s];
}

// Convert local spreadsheet clock in an IANA time zone into an instant.
function localTimeToIso(date, clock, zone, isEnd) {
  const [hours, minutes, seconds] = parseClock(clock, isEnd);
  let day = date;
  let h = hours;
  if (h === 24) {
    day = new Date(Date.parse(`${date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
    h = 0;
  }
  const utc = Date.UTC(...day.split('-').map((v, i) => Number(v) - (i === 1 ? 1 : 0)), h, minutes, seconds);
  let guess = utc;
  for (let i = 0; i < 4; i++) {
    const p = partsFor(guess, zone);
    const viewed = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
    guess += utc - viewed;
  }
  const result = partsFor(guess, zone);
  const resultDate = `${result.year}-${result.month}-${result.day}`;
  if (resultDate !== day || Number(result.hour) !== h || Number(result.minute) !== minutes) {
    throw new Error(`Время ${clock} не существует в часовом поясе ${zone}`);
  }
  return new Date(guess).toISOString();
}

function decimalHours(ms) {
  return Math.round((ms / 3600000) * 10000) / 10000;
}

function entryRow(entry, projectName, fallbackZone) {
  const zone = entry.timeZone || fallbackZone;
  return [
    safeText(projectName),
    timeFor(entry.startedAt, zone, entry.date, false),
    timeFor(entry.endedAt, zone, entry.date, true),
    formatDuration(entry.durationMs),
    decimalHours(entry.durationMs),
    safeText(entry.taskDescription),
  ];
}

function snapshotHash(values) {
  // Do not compare E; it is calculated from D.
  const source = JSON.stringify([values[0], values[1], values[2], values[3], values[5]]);
  let a = 2166136261;
  let b = 5381;
  for (let i = 0; i < source.length; i++) {
    const char = source.charCodeAt(i);
    a = Math.imul(a ^ char, 16777619);
    b = Math.imul(b ^ char, 33);
  }
  return `${a >>> 0}-${b >>> 0}`;
}

function findProject(registry, id, name) {
  return registry.find((p) => id && p.id === id) ||
    registry.find((p) => name && normalize(p.name) === normalize(name));
}

function makeProject(registry, requests, project) {
  const name = String(project.name ?? '').trim();
  if (!name || name.length > 100) throw new Error('Некорректное имя проекта');
  const already = findProject(registry, project.id, name);
  if (already) return already;
  const created = {
    id: project.id || randomId(), name,
    createdAt: project.createdAt || nowIso(), updatedAt: project.updatedAt || nowIso(),
  };
  registry.push(created);
  requests.push(metadataCreate(PROJECT_META, created, { spreadsheet: true }));
  return created;
}

function remainingSheetId(data) {
  const used = new Set((data.sheets ?? []).map((sheet) => sheet.properties.sheetId));
  let id;
  do { id = crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff; } while (!id || used.has(id));
  return id;
}

export async function syncSheetData(spreadsheetId, body) {
  const deletedIds = new Set(body.deletedEntryIds);
  const deletedRecords = (body.deletedEntryRecords ?? []).filter((entry) => deletedIds.has(entry.id));
  const deletedProjects = body.deletedProjects;
  const initial = await loadSpreadsheet(spreadsheetId);
  const registry = existingProjects(initial);
  const alias = new Map();
  const firstRequests = [];
  const initialRows = readDateSheets(initial);
  // Upgrade existing v3 date tabs even when there are no new local entries.
  for (const sheet of initial.sheets ?? []) {
    if (!sheetDate(sheet.properties?.title)) continue;
    const first = readCells(sheet).find((r) => r.index === 0)?.values ?? [];
    if ((sheet.properties.gridProperties?.columnCount ?? 6) < 6 ||
        !HEADERS.every((heading, index) => first[index] === heading)) {
      firstRequests.push(...headerRequests(sheet));
    }
  }
  let deleted = 0;
  let createdTabs = 0;

  // Project deletions take precedence over additions and renames.
  const deletedRemoteIds = new Set();
  for (const tombstone of deletedProjects) {
    const remote = findProject(registry, tombstone.remoteProjectId || tombstone.id, tombstone.previousName || tombstone.name);
    if (remote) {
      deletedRemoteIds.add(remote.id);
      if (remote.metadataId) firstRequests.push(metadataDelete(remote.metadataId));
      registry.splice(registry.indexOf(remote), 1);
    }
  }

  for (const project of body.projects) {
    if (!project?.id) throw new Error('Не указан ID проекта');
    const remote = findProject(registry, project.remoteProjectId || project.id, project.previousName || project.name);
    if (remote) {
      alias.set(project.id, remote.id);
      if (project.syncStatus === 'pending' && remote.name !== project.name) {
        if (registry.some((p) => p.id !== remote.id && normalize(p.name) === normalize(project.name))) {
          throw new Error(`Проект «${project.name}» уже существует`);
        }
        const oldName = remote.name;
        remote.name = project.name;
        remote.updatedAt = project.updatedAt || nowIso();
        if (remote.metadataId) firstRequests.push(metadataUpdate(remote.metadataId, {
          id: remote.id, name: remote.name, createdAt: remote.createdAt, updatedAt: remote.updatedAt,
        }));
        for (const row of initialRows) {
          if ((row.stored?.projectId === remote.id || normalize(row.values[0]) === normalize(oldName)) && normalize(row.values[0]) === normalize(oldName)) {
            firstRequests.push(singleCell(row.sheet.properties.sheetId, row.index, 0, project.name));
          }
        }
      }
    } else {
      const created = makeProject(registry, firstRequests, project);
      alias.set(project.id, created.id);
    }
  }

  const toRemove = [];
  // A row can temporarily have no metadata (e.g. legacy imports or partial
  // migration). Keep a snapshot of the deleted session and match it by its
  // visible values instead of silently acknowledging a failed deletion.
  const deletedRecordMatches = (row, record) => {
    if (row.date !== record.date) return false;
    if (row.stored?.id && row.stored.id !== record.id) return false;
    const zone = record.timeZone || initial.properties?.timeZone ||
      Intl.DateTimeFormat().resolvedOptions().timeZone;
    const name = normalize(row.values[0]);
    const names = [record.projectName, registry.find((p) => p.id === record.projectId)?.name]
      .filter(Boolean).map(normalize);
    if (!names.includes(name)) return false;
    return row.values[1] === timeFor(record.startedAt, zone, record.date, false) &&
      row.values[2] === timeFor(record.endedAt, zone, record.date, true) &&
      row.values[3] === formatDuration(record.durationMs) &&
      row.values[5] === String(record.taskDescription ?? '').trim();
  };
  for (const row of initialRows) {
    const tombstone = deletedProjects.find((item) => {
      const target = item.remoteProjectId || item.id;
      return (row.stored?.projectId === target ||
        normalize(row.values[0]) === normalize(item.name) ||
        (item.previousName && normalize(row.values[0]) === normalize(item.previousName)));
    });
    const wasMoved = tombstone && ![tombstone.name, tombstone.previousName]
      .some((name) => name && normalize(row.values[0]) === normalize(name));
    if (deletedIds.has(row.stored?.id) || (tombstone && !wasMoved)) {
      toRemove.push(row);
    }
  }
  for (const record of deletedRecords) {
    if (toRemove.some((row) => row.stored?.id === record.id)) continue;
    const matches = initialRows.filter((row) => deletedRecordMatches(row, record));
    if (matches.length > 1) {
      throw new Error(`Нельзя однозначно определить строку удаляемой сессии «${record.projectName}». ` +
        'Проверьте повторяющиеся строки в Google Таблице.');
    }
    if (matches.length === 1 && !toRemove.includes(matches[0])) {
      toRemove.push(matches[0]);
    }
  }
  // Delete bottom-to-top, so indices for the same sheet remain valid.
  toRemove.sort((a, b) => a.sheet.properties.sheetId - b.sheet.properties.sheetId || b.index - a.index);
  for (const row of toRemove) {
    firstRequests.push({ deleteDimension: {
      range: { sheetId: row.sheet.properties.sheetId, dimension: 'ROWS', startIndex: row.index, endIndex: row.index + 1 },
    } });
    deleted++;
  }

  await applyRequests(spreadsheetId, firstRequests);
  const mid = await loadSpreadsheet(spreadsheetId);
  const rows = readDateSheets(mid);
  const presentIds = new Set(rows.map((row) => row.stored?.id).filter(Boolean));
  const append = [];
  const sheetsByTitle = new Map((mid.sheets ?? []).map((sheet) => [sheet.properties.title, sheet]));
  const pendingByDate = new Map();
  const zone = mid.properties?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  for (const entry of body.entries) {
    if (!entry?.id || !entry.sessionId || !entry.projectId || !entry.date || !Number.isFinite(entry.durationMs) || entry.durationMs < 0) {
      throw new Error('Некорректная запись времени');
    }
    if (presentIds.has(entry.id) || deletedIds.has(entry.id)) continue;
    const project = findProject(registry, alias.get(entry.projectId) || entry.projectId, entry.projectName);
    if (!project || deletedRemoteIds.has(project.id)) continue;
    const arr = pendingByDate.get(entry.date) || [];
    arr.push({ entry, project });
    pendingByDate.set(entry.date, arr);
    presentIds.add(entry.id);
  }

  for (const [date, items] of pendingByDate) {
    const title = tabTitle(date);
    let sheet = sheetsByTitle.get(title);
    if (!sheet) {
      const sheetId = remainingSheetId({ sheets: [...sheetsByTitle.values()] });
      sheet = { properties: { sheetId, title, gridProperties: { rowCount: 100, columnCount: 6 } }, data: [] };
      sheetsByTitle.set(title, sheet);
      append.push(...addDateSheetRequests(sheetId, title));
      createdTabs++;
    }
    if (!append.some((req) => req.updateCells?.start?.sheetId === sheet.properties.sheetId && req.updateCells?.start?.rowIndex === 0)) {
      append.push(...headerRequests({ ...sheet, properties: {
        ...sheet.properties, gridProperties: { ...sheet.properties.gridProperties, columnCount: 6 },
      } }));
    }
    const sheetRows = rows.filter((r) => r.sheet.properties.sheetId === sheet.properties.sheetId);
    let nextRow = Math.max(1, ...sheetRows.map((r) => r.index + 1));
    const requiredRows = nextRow + items.length;
    const allocatedRows = sheet.properties.gridProperties?.rowCount || 100;
    if (requiredRows > allocatedRows) {
      append.push({ appendDimension: { sheetId: sheet.properties.sheetId, dimension: 'ROWS', length: requiredRows - allocatedRows } });
    }
    for (const { entry, project } of items) {
      const values = entryRow(entry, project.name, zone);
      append.push(writeCells(sheet.properties.sheetId, nextRow, values));
      append.push(metadataCreate(ROW_META, {
        ...entry, projectId: project.id, projectName: project.name,
        timeZone: entry.timeZone || zone, snapshotV4Hash: snapshotHash(values.map(String)),
      }, { dimensionRange: {
        sheetId: sheet.properties.sheetId, dimension: 'ROWS', startIndex: nextRow, endIndex: nextRow + 1,
      } }));
      nextRow++;
    }
  }
  await applyRequests(spreadsheetId, append);

  // Reading from the spreadsheet (rather than echoing local entries) lets
  // manual additions, edits and deletions flow back into the extension.
  const after = await loadSpreadsheet(spreadsheetId);
  const afterRows = readDateSheets(after);
  const confirmedDeletedIds = [...deletedIds].filter((id) => {
    if (afterRows.some((row) => row.stored?.id === id)) return false;
    const record = deletedRecords.find((entry) => entry.id === id);
    return !record || !afterRows.some((row) => deletedRecordMatches(row, record));
  });
  const parsedProjects = existingProjects(after);
  const finalChanges = [];
  const entries = [];
  const seenIds = new Set();
  const effectiveZone = after.properties?.timeZone || zone;
  for (const row of afterRows) {
    const [name, start, end, duration, , description] = row.values;
    if (!name || !start || !end) {
      throw new Error(`Заполните проект, начало и конец: ${row.sheet.properties.title}, строка ${row.index + 1}`);
    }
    if (deletedProjects.some((item) => [item.name, item.previousName]
      .some((oldName) => oldName && normalize(oldName) === normalize(name)) &&
      !body.projects.some((p) => normalize(p.name) === normalize(name)))) {
      continue;
    }
    let project = parsedProjects.find((p) => normalize(p.name) === normalize(name));
    if (!project) {
      project = makeProject(parsedProjects, finalChanges, { name });
    }
    const stored = row.stored;
    const timeZone = stored?.timeZone || effectiveZone;
    const unchanged = stored?.snapshotV4Hash === snapshotHash(row.values) && stored.date === row.date;
    const startedAt = unchanged ? stored.startedAt : localTimeToIso(row.date, start, timeZone, false);
    const endedAt = unchanged ? stored.endedAt : localTimeToIso(row.date, end, timeZone, true);
    if (Date.parse(endedAt) < Date.parse(startedAt)) {
      throw new Error(`Конец раньше начала: ${row.sheet.properties.title}, строка ${row.index + 1}`);
    }
    const durationMs = unchanged ? stored.durationMs : (duration ? parseDuration(duration) : Date.parse(endedAt) - Date.parse(startedAt));
    if (!duration) {
      row.values[3] = formatDuration(durationMs);
      finalChanges.push(singleCell(row.sheet.properties.sheetId, row.index, 3, row.values[3]));
    }
    const hours = decimalHours(durationMs);
    if (Math.abs(Number(row.values[4].replace(',', '.')) - hours) > 0.00001 || row.values[4] === '') {
      finalChanges.push(singleCell(row.sheet.properties.sheetId, row.index, 4, hours));
    }
    const id = stored?.id && !seenIds.has(stored.id) ? stored.id : randomId();
    seenIds.add(id);
    const entry = {
      id, sessionId: stored?.sessionId || randomId(),
      projectId: project.id, projectName: project.name, date: row.date,
      startedAt, endedAt, durationMs, timeZone,
      taskDescription: description || '', syncStatus: 'synced',
      createdAt: stored?.createdAt || nowIso(),
    };
    entries.push(entry);
    const metadata = { ...entry, snapshotV4Hash: snapshotHash(row.values) };
    if (!row.meta) {
      finalChanges.push(metadataCreate(ROW_META, metadata, { dimensionRange: {
        sheetId: row.sheet.properties.sheetId, dimension: 'ROWS', startIndex: row.index, endIndex: row.index + 1,
      } }));
    } else if (row.meta.metadataValue !== JSON.stringify(metadata)) {
      finalChanges.push(metadataUpdate(row.meta.metadataId, metadata));
    }
  }
  // Newly created projects in finalChanges should not be repeated on every poll.
  await applyRequests(spreadsheetId, finalChanges);
  return {
    version: '4.0.0',
    uploaded: [...pendingByDate.values()].reduce((sum, arr) => sum + arr.length, 0),
    deleted,
    createdTabs,
    deletedIds: confirmedDeletedIds,
    deletedProjectIds: deletedProjects.map((item) => item.id),
    projects: parsedProjects.map(({ id, name, createdAt, updatedAt }) => ({ id, name, createdAt, updatedAt })),
    entries,
  };
}
