/** Time Tracker Apps Script v4.0.0. Configure SYNC_SECRET and SPREADSHEET_ID
 * in Project Settings > Script properties. Deploy as Web App: Execute as Me.
 * Back up your spreadsheet before upgrading from v3.
 */
const HEADERS = [
  'Проект',
  'Начало',
  'Конец',
  'Длительность',
  'Время для трекера',
  'Описание задачи',
];
const PROJECT_META = 'TRACKER_PROJECT_V3';
const ROW_META = 'TRACKER_ENTRY_V3';
const DATE_RE = /^(\d{2})\.(\d{2})\.(\d{4})$/;
const VERSION = '4.0.0';

function jsonResponse(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return jsonResponse({ ok: true, version: VERSION, build: 'safe-delete-2', message: 'Time Tracker API' });
}

function doPost(e) {
  try {
    const body = JSON.parse(e && e.postData ? e.postData.contents : '{}');
    const props = PropertiesService.getScriptProperties();
    const secret = props.getProperty('SYNC_SECRET');
    const spreadsheetId = props.getProperty('SPREADSHEET_ID');
    if (!secret || !spreadsheetId) throw new Error('Сервер не настроен');
    if (!body.secret || body.secret !== secret) throw new Error('Неверный ключ доступа');
    if (body.action !== 'sync' || body.protocolVersion !== 4) {
      throw new Error('Требуется клиент синхронизации v4');
    }
    for (const key of ['projects', 'entries', 'deletedEntryIds', 'deletedProjects']) {
      if (!Array.isArray(body[key])) throw new Error(`Отсутствует массив ${key}`);
    }
    if (body.projects.length > 200 || body.entries.length > 5000 ||
        body.deletedEntryIds.length > 5000 || body.deletedProjects.length > 200) {
      throw new Error('Слишком большой пакет данных');
    }

    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
      const result = syncData(spreadsheet, body);
      SpreadsheetApp.flush();
      return jsonResponse({ ok: true, version: VERSION, ...result });
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    console.error(error.stack || error);
    return jsonResponse({ ok: false, error: error.message });
  }
}

function parseMeta(meta) {
  try { return JSON.parse(meta.getValue() || '{}'); } catch { return null; }
}

function rowMeta(sheet, row) {
  return sheet.getRange(`${row}:${row}`).getDeveloperMetadata()
    .find((item) => item.getKey() === ROW_META) || null;
}

function projectRegistry(spreadsheet) {
  const result = [];
  for (const meta of spreadsheet.getDeveloperMetadata()) {
    if (meta.getKey() !== PROJECT_META) continue;
    const project = parseMeta(meta);
    if (project && project.id && project.name) result.push({ ...project, meta });
  }
  return result;
}

function normalizeName(value) {
  return String(value == null ? '' : value).trim().toLocaleLowerCase('ru');
}

function validateProjectName(name) {
  const text = String(name || '').trim();
  if (!text || text.length > 100 || /^[=+@-]/.test(text)) {
    throw new Error('Некорректное название проекта');
  }
  return text;
}

function findProject(registry, id, name) {
  return registry.find((item) => item.id === id) ||
    (name ? registry.find((item) => normalizeName(item.name) === normalizeName(name)) : null);
}

function registerProject(spreadsheet, registry, name, id, createdAt) {
  const clean = validateProjectName(name);
  let project = findProject(registry, id, clean);
  if (project) return project;

  project = {
    id: id || Utilities.getUuid(),
    name: clean,
    createdAt: createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  spreadsheet.addDeveloperMetadata(PROJECT_META, JSON.stringify(project));
  registry.push(project);
  return project;
}

function saveProject(project) {
  if (project.meta) {
    const { meta, ...data } = project;
    meta.setValue(JSON.stringify(data));
  }
}

function dateForSheet(title) {
  const m = title.match(DATE_RE);
  if (!m) return null;
  const [, day, month, year] = m;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) ||
      date.getUTCMonth() !== Number(month) - 1 ||
      date.getUTCDate() !== Number(day)) return null;
  return `${year}-${month}-${day}`;
}

function sheetName(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Некорректная дата');
  const [year, month, day] = date.split('-');
  const name = `${day}.${month}.${year}`;
  if (dateForSheet(name) !== date) throw new Error('Некорректная дата');
  return name;
}

function ensureDateSheet(spreadsheet, date) {
  const name = sheetName(date);
  const sheet = spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
  if (sheet.getMaxColumns() < 6) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), 6 - sheet.getMaxColumns());
  }
  if (sheet.getLastRow() > 0) {
    const headers = sheet.getRange(1, 1, 1, 4).getDisplayValues()[0];
    for (let i = 0; i < 4; i++) {
      if (headers[i] !== HEADERS[i]) {
        throw new Error(`Неверные заголовки на вкладке «${name}»`);
      }
    }
  }

  // Compatible with old v3 sheets: retain existing rows and metadata.
  sheet.getRange(1, 1, 1, 6).setValues([HEADERS]);
  sheet.getRange(1, 1, 1, 6)
    .setBackground('#F1BC00').setFontColor('#000000').setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 180);
  sheet.setColumnWidth(2, 100);
  sheet.setColumnWidth(3, 100);
  sheet.setColumnWidth(4, 125);
  sheet.setColumnWidth(5, 140);
  sheet.setColumnWidth(6, 320);
  if (sheet.getLastRow() >= 2) {
    sheet.getRange(2, 5, sheet.getLastRow() - 1, 1).setNumberFormat('0.####');
  }
  return sheet;
}

function clockParts(text, allow24) {
  const m = String(text || '').trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) throw new Error(`Некорректное время: ${text}`);
  const h = Number(m[1]); const min = Number(m[2]); const sec = Number(m[3] || 0);
  if (min > 59 || sec > 59 || h > 24 || (h === 24 && (!allow24 || min || sec))) {
    throw new Error(`Некорректное время: ${text}`);
  }
  return [h, min, sec];
}

function timestamp(date, value, zone, allow24) {
  const [h, m, s] = clockParts(value, allow24);
  let day = date;
  let hour = h;
  if (h === 24) {
    const next = new Date(`${date}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    day = Utilities.formatDate(next, 'UTC', 'yyyy-MM-dd');
    hour = 0;
  }
  const time = [hour, m, s].map((x) => String(x).padStart(2, '0')).join(':');
  return Utilities.parseDate(`${day} ${time}`, zone, 'yyyy-MM-dd HH:mm:ss').toISOString();
}

function displayTime(iso, zone, date, isEnd) {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) throw new Error('Некорректное время записи');
  const time = Utilities.formatDate(instant, zone, 'HH:mm:ss');
  const actualDate = Utilities.formatDate(instant, zone, 'yyyy-MM-dd');
  return isEnd && actualDate !== date && time === '00:00:00' ? '24:00:00' : time;
}

function parseDuration(text) {
  const match = String(text || '').trim().match(/^(\d+):(\d{2}):(\d{2})$/);
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) {
    throw new Error(`Некорректная длительность: ${text}. Формат: ЧЧ:ММ:СС`);
  }
  return (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000;
}

function durationText(ms) {
  const seconds = Math.floor(ms / 1000);
  return [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60]
    .map((x) => String(x).padStart(2, '0')).join(':');
}

function decimalHours(ms) {
  return Math.round((ms / 3600000) * 10000) / 10000;
}

function safeText(value) {
  const text = String(value || '').slice(0, 500);
  return /^[=+@-]/.test(text) ? `'${text}` : text;
}

function entryValues(entry, projectName, zone) {
  return [
    safeText(projectName),
    displayTime(entry.startedAt, entry.timeZone || zone, entry.date, false),
    displayTime(entry.endedAt, entry.timeZone || zone, entry.date, true),
    durationText(entry.durationMs),
    decimalHours(entry.durationMs),
    safeText(entry.taskDescription || ''),
  ];
}

function rowSnapshot(values) {
  // Column E is calculated, so it does not participate in change detection.
  return [values[0], values[1], values[2], values[3], values[5]];
}

function snapshotHash(values) {
  // Compact change detector: do not duplicate long descriptions inside metadata.
  const source = JSON.stringify(rowSnapshot(values));
  let first = 2166136261;
  let second = 5381;
  for (let index = 0; index < source.length; index++) {
    const char = source.charCodeAt(index);
    first = Math.imul(first ^ char, 16777619);
    second = Math.imul(second ^ char, 33);
  }
  return `${first >>> 0}-${second >>> 0}`;
}

function writeRow(sheet, row, values) {
  sheet.getRange(row, 1, 1, 4).setNumberFormat('@').setValues([values.slice(0, 4)]);
  sheet.getRange(row, 5).setNumberFormat('0.####').setValue(values[4]);
  sheet.getRange(row, 6).setNumberFormat('@').setValue(values[5]);
}

function projectRowOperations(spreadsheet, project, nextName, remove) {
  const oldName = project.name;
  for (const sheet of spreadsheet.getSheets()) {
    if (!dateForSheet(sheet.getName()) || sheet.getLastRow() < 2) continue;
    for (let row = sheet.getLastRow(); row >= 2; row--) {
      const meta = rowMeta(sheet, row);
      const stored = meta && parseMeta(meta);
      const displayName = String(sheet.getRange(row, 1).getDisplayValue()).trim();
      // The visible project name is authoritative when a user manually
      // reassigns a row in Google Sheets. Never delete a reassigned row.
      const sameDisplayedProject = normalizeName(displayName) === normalizeName(oldName);
      // Older sessions may contain a stale local/remote project ID.
      // The visible name is the authoritative assignment of the row.
      // If the user moved the row to another project, the names differ
      // and the row is preserved.
      if (!sameDisplayedProject) continue;
      if (remove) {
        sheet.deleteRow(row);
      } else {
        sheet.getRange(row, 1).setNumberFormat('@').setValue(safeText(nextName));
        if (stored && meta) {
          const values = sheet.getRange(row, 1, 1, 6).getDisplayValues()[0];
          const next = { ...stored, projectName: nextName, snapshotV4Hash: snapshotHash(values) };
          meta.setValue(JSON.stringify(next));
        }
      }
    }
  }
}

function syncData(spreadsheet, body) {
  const registry = projectRegistry(spreadsheet);
  const deletedEntryIds = new Set(body.deletedEntryIds);
  const deletedProjectIds = [];
  const aliases = new Map();
  let uploaded = 0; let deleted = 0; let createdTabs = 0;
  const existingSheetIds = new Set(spreadsheet.getSheets().map((sheet) => sheet.getSheetId()));

  // Deletions first: don't re-register deleted projects.
  for (const tombstone of body.deletedProjects) {
    if (!tombstone?.id) continue;
    // Project deletion must be matched by stable ID, not by reused name.
    // A name-only fallback can erase an unrelated newly-created project.
    const expectedId = tombstone.remoteProjectId || tombstone.id;
    const project = registry.find((item) => item.id === expectedId);
    if (!project) {
      const matchingName = registry.find((item) =>
        [tombstone.previousName, tombstone.name]
          .some((name) => name && normalizeName(item.name) === normalizeName(name))
      );
      if (matchingName) {
        throw new Error(
          `Не удалось безопасно удалить «${tombstone.name}»: ID проекта ` +
          'в таблице не совпадает. Обновите данные перед повторной попыткой.'
        );
      }
    }
    if (project) {
      projectRowOperations(spreadsheet, project, null, true);
      if (project.meta) project.meta.remove();
      registry.splice(registry.indexOf(project), 1);
    }
    // Retry cleanup even if the project metadata was removed in an earlier
    // run. Otherwise, an orphan row can re-register a deleted project.
    const names = [project?.name, tombstone.name, tombstone.previousName]
      .filter(Boolean);
    for (const name of [...new Set(names.map(normalizeName))]) {
      if (registry.some((item) => normalizeName(item.name) === name)) continue;
      projectRowOperations(spreadsheet, { id: expectedId, name }, null, true);
    }
    deletedProjectIds.push(tombstone.id);
  }

  // Register projects and apply intentional local renames only when marked pending.
  for (const item of body.projects) {
    if (!item || !item.id) throw new Error('Некорректный проект');
    const name = validateProjectName(item.name);
    const expectedProjectId = item.remoteProjectId || item.id;
    const sameIdProject = registry.find((existing) => existing.id === expectedProjectId);
    // A stale local ID must not rename an unrelated project which happens
    // to have the same former name. Existing synced projects have remoteProjectId.
    if (!sameIdProject && item.syncStatus === 'pending' && item.previousName) {
      const oldNameMatch = registry.find((existing) =>
        normalizeName(existing.name) === normalizeName(item.previousName)
      );
      if (oldNameMatch) {
        throw new Error(
          `Не удалось безопасно переименовать «${item.previousName}»: ID проекта ` +
          'в таблице не совпадает. Сначала синхронизируйте проекты.'
        );
      }
    }
    let project = sameIdProject || findProject(registry, expectedProjectId, item.previousName || name);
    if (!project) {
      project = registerProject(spreadsheet, registry, name, item.id, item.createdAt);
    } else if (item.syncStatus === 'pending' && name !== project.name) {
      // Reject colliding names rather than merging distinct projects.
      if (registry.some((other) => other.id !== project.id && normalizeName(other.name) === normalizeName(name))) {
        throw new Error(`Название «${name}» уже используется`);
      }
      projectRowOperations(spreadsheet, project, name, false);
      project.name = name;
      project.updatedAt = item.updatedAt || new Date().toISOString();
      saveProject(project);
    }
    aliases.set(item.id, project.id);
  }

  for (const sheet of spreadsheet.getSheets()) {
    const date = dateForSheet(sheet.getName());
    if (!date) continue;
    ensureDateSheet(spreadsheet, date);
    for (let row = sheet.getLastRow(); row >= 2; row--) {
      const meta = rowMeta(sheet, row);
      const stored = meta && parseMeta(meta);
      if (stored?.id && deletedEntryIds.has(stored.id)) {
        sheet.deleteRow(row);
        deleted++;
      }
    }
  }

  const presentIds = new Set();
  for (const sheet of spreadsheet.getSheets()) {
    if (!dateForSheet(sheet.getName())) continue;
    for (let row = 2; row <= sheet.getLastRow(); row++) {
      const stored = parseMeta(rowMeta(sheet, row) || { getValue: () => '{}' });
      if (stored?.id) presentIds.add(stored.id);
    }
  }

  const zone = spreadsheet.getSpreadsheetTimeZone();
  for (const entry of body.entries) {
    if (deletedEntryIds.has(entry.id) || presentIds.has(entry.id)) continue;
    if (!entry.id || !entry.sessionId || !entry.projectId || !entry.date ||
      !Number.isFinite(entry.durationMs) || entry.durationMs < 0) {
      throw new Error('Некорректная запись времени');
    }
    const projectId = aliases.get(entry.projectId) || entry.projectId;
    const project = findProject(registry, projectId, entry.projectName);
    if (!project) throw new Error(`Не найден проект для записи ${entry.id}`);

    const sheet = ensureDateSheet(spreadsheet, entry.date);
    if (!existingSheetIds.has(sheet.getSheetId())) {
      existingSheetIds.add(sheet.getSheetId());
      createdTabs++;
    }
    const row = sheet.getLastRow() + 1;
    if (row > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 1);
    const values = entryValues(entry, project.name, zone);
    writeRow(sheet, row, values);
    const saved = {
      ...entry,
      projectId: project.id,
      projectName: project.name,
      timeZone: entry.timeZone || zone,
      taskDescription: entry.taskDescription || '',
      snapshotV4Hash: snapshotHash(values.map(String)),
    };
    sheet.getRange(`${row}:${row}`).addDeveloperMetadata(ROW_META, JSON.stringify(saved));
    presentIds.add(entry.id);
    uploaded++;
  }

  const entries = [];
  const seenIds = new Set();
  const deletedNames = new Set(body.deletedProjects.flatMap((item) =>
    [item.name, item.previousName].filter(Boolean).map(normalizeName))); 
  for (const sheet of spreadsheet.getSheets()) {
    const date = dateForSheet(sheet.getName());
    if (!date) continue;
    ensureDateSheet(spreadsheet, date);
    if (sheet.getLastRow() < 2) continue;
    const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).getDisplayValues();
    for (let index = 0; index < rows.length; index++) {
      const values = rows[index].map((value) => String(value).trim());
      if (!values.some(Boolean)) continue;
      const row = index + 2;
      if (!values[0] || !values[1] || !values[2]) {
        throw new Error(`Заполните проект, начало и конец: ${sheet.getName()}, строка ${row}`);
      }
      // Never acknowledge a deletion while its project name still survives
      // in a date tab; the normal read would recreate that project.
      if (deletedNames.has(normalizeName(values[0])) &&
          !body.projects.some((item) => normalizeName(item.name) === normalizeName(values[0]))) {
        throw new Error(`После удаления «${values[0]}» осталась строка ${row} на листе ${sheet.getName()}`);
      }
      const meta = rowMeta(sheet, row);
      const stored = meta && parseMeta(meta);
      const project = registerProject(spreadsheet, registry, values[0]);
      const timeZone = stored?.timeZone || zone;
      const unchanged = stored && stored.date === date && stored.snapshotV4Hash &&
        stored.snapshotV4Hash === snapshotHash(values);
      let startedAt; let endedAt; let durationMs;
      if (unchanged) {
        startedAt = stored.startedAt;
        endedAt = stored.endedAt;
        durationMs = stored.durationMs;
      } else {
        startedAt = timestamp(date, values[1], timeZone, false);
        endedAt = timestamp(date, values[2], timeZone, true);
        if (Date.parse(endedAt) < Date.parse(startedAt)) {
          throw new Error(`Конец раньше начала: ${sheet.getName()}, строка ${row}`);
        }
        durationMs = values[3]
          ? parseDuration(values[3])
          : Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
      }
      if (!values[3]) {
        values[3] = durationText(durationMs);
        sheet.getRange(row, 4).setNumberFormat('@').setValue(values[3]);
      }
      const hours = decimalHours(durationMs);
      const cellHours = Number(sheet.getRange(row, 5).getValue());
      if (Math.abs(cellHours - hours) > 0.00001 || values[4] === '') {
        sheet.getRange(row, 5).setNumberFormat('0.####').setValue(hours);
      }
      const id = stored?.id && !seenIds.has(stored.id) ? stored.id : Utilities.getUuid();
      const entry = {
        id,
        sessionId: stored?.sessionId || Utilities.getUuid(),
        projectId: project.id,
        projectName: project.name,
        taskDescription: values[5] || '',
        date,
        startedAt,
        endedAt,
        durationMs,
        timeZone,
        syncStatus: 'synced',
        createdAt: stored?.createdAt || new Date().toISOString(),
      };
      seenIds.add(id);
      entries.push(entry);
      const nextMeta = JSON.stringify({ ...entry, snapshotV4Hash: snapshotHash(values) });
      if (meta) {
        if (meta.getValue() !== nextMeta) meta.setValue(nextMeta);
      } else {
        sheet.getRange(`${row}:${row}`).addDeveloperMetadata(ROW_META, nextMeta);
      }
    }
  }

  return {
    uploaded,
    deleted,
    createdTabs,
    deletedIds: [...deletedEntryIds],
    deletedProjectIds,
    projects: registry.map(({ id, name, createdAt, updatedAt }) => ({ id, name, createdAt, updatedAt })),
    entries,
  };
}

/** A harmless standalone test (does not modify the spreadsheet). */
function testHours() {
  const samples = [
    [30 * 60000, 0.5],
    [45 * 60000, 0.75],
    [90 * 60000, 1.5],
  ];
  samples.forEach(([milliseconds, expected]) => {
    if (decimalHours(milliseconds) !== expected) throw new Error('Ошибка перевода часов');
  });
  console.log('Проверка десятичных часов пройдена');
}
