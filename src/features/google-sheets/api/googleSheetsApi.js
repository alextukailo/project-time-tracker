
import { syncSheetData } from './directSheetsSync';
import { extractSpreadsheetId, spreadsheetUrl, verifySpreadsheetAccess } from './sheetsClient';
import { getGoogleAccessToken, signInWithGoogle, signOutFromGoogle } from './oauth';

const PROJECTS_KEY = 'projects';
const ENTRIES_KEY = 'timeEntries';
const DELETED_ENTRIES_KEY = 'deletedEntryIds';
const DELETED_RECORDS_KEY = 'deletedEntryRecords';
const DELETED_PROJECTS_KEY = 'deletedProjects';
const DELETED_PROJECTS_HISTORY_KEY = 'deletedProjectsHistory';
const MIGRATED_KEY = 'dateTabsMigrationV3';
const SELECTED_ID_KEY = 'selectedSpreadsheetId';
const PROFILES_KEY = 'oauthSpreadsheetProfiles';
const SELECTED_TITLE_KEY = 'selectedSpreadsheetTitle';
const STATE_KEYS = [PROJECTS_KEY, ENTRIES_KEY, DELETED_ENTRIES_KEY, DELETED_RECORDS_KEY,
  DELETED_PROJECTS_KEY, DELETED_PROJECTS_HISTORY_KEY, MIGRATED_KEY];

export async function getSyncConfig() {
  const state = await chrome.storage.local.get([SELECTED_ID_KEY, SELECTED_TITLE_KEY]);
  const id = state[SELECTED_ID_KEY];
  return id ? {
    configured: true, spreadsheetId: id, spreadsheetTitle: state[SELECTED_TITLE_KEY] || 'Google Таблица',
    spreadsheetUrl: spreadsheetUrl(id),
  } : null;
}

async function saveCurrentProfile(nextId, nextTitle, importLocal) {
  const state = await chrome.storage.local.get([...STATE_KEYS, SELECTED_ID_KEY,
    SELECTED_TITLE_KEY, PROFILES_KEY]);
  const previousId = state[SELECTED_ID_KEY] || 'legacy';
  const profiles = state[PROFILES_KEY] || {};
  // All state, including tombstones, is kept separately for each spreadsheet.
  profiles[previousId] = Object.fromEntries(STATE_KEYS.map((key) => [key, state[key]]));
  const restored = profiles[nextId];
  const empty = {
    [PROJECTS_KEY]: [], [ENTRIES_KEY]: [], [DELETED_ENTRIES_KEY]: [], [DELETED_RECORDS_KEY]: [],
    [DELETED_PROJECTS_KEY]: [], [DELETED_PROJECTS_HISTORY_KEY]: [], [MIGRATED_KEY]: false,
  };
  const nextState = restored ? { ...empty, ...restored } : importLocal ? {
    ...empty,
    [PROJECTS_KEY]: (state[PROJECTS_KEY] || []).map((p) => ({ ...p, syncStatus: 'pending', remoteProjectId: null })),
    [ENTRIES_KEY]: (state[ENTRIES_KEY] || []).map((e) => ({ ...e, syncStatus: 'pending' })),
  } : empty;
  await chrome.storage.local.set({
    ...nextState,
    [SELECTED_ID_KEY]: nextId,
    [SELECTED_TITLE_KEY]: nextTitle,
    [PROFILES_KEY]: profiles,
  });
}

export async function connectSpreadsheet(url, { importLocal = false } = {}) {
  const id = extractSpreadsheetId(url);
  // A token must already have been granted by the explicit Sign In button.
  await getGoogleAccessToken(false);
  const sheet = await verifySpreadsheetAccess(id);
  const state = await chrome.storage.local.get([SELECTED_ID_KEY, PROJECTS_KEY]);
  if (state[SELECTED_ID_KEY] === id) {
    await chrome.storage.local.set({ [SELECTED_TITLE_KEY]: sheet.title });
    return getSyncConfig();
  }
  if ((state[PROJECTS_KEY] || []).some((p) => p.status !== 'idle')) {
    throw new Error('Остановите или завершите активную сессию перед сменой таблицы.');
  }
  await saveCurrentProfile(id, sheet.title, importLocal);
  return getSyncConfig();
}

export async function disconnectSpreadsheet() {
  const state = await chrome.storage.local.get([...STATE_KEYS, SELECTED_ID_KEY, PROFILES_KEY]);
  if ((state[PROJECTS_KEY] || []).some((project) => project.status !== 'idle')) {
    throw new Error('Остановите или завершите активную сессию перед отключением таблицы.');
  }
  const profiles = state[PROFILES_KEY] || {};
  if (state[SELECTED_ID_KEY]) {
    // Preserve the disconnected spreadsheet's local changes for a later reconnect.
    profiles[state[SELECTED_ID_KEY]] = Object.fromEntries(
      STATE_KEYS.map((key) => [key, state[key]])
    );
  }
  const emptyState = {
    [PROJECTS_KEY]: [], [ENTRIES_KEY]: [], [DELETED_ENTRIES_KEY]: [], [DELETED_RECORDS_KEY]: [],
    [DELETED_PROJECTS_KEY]: [], [DELETED_PROJECTS_HISTORY_KEY]: [], [MIGRATED_KEY]: false,
  };
  await chrome.storage.local.set({
    ...emptyState,
    ...(profiles.legacy || {}),
    [PROFILES_KEY]: profiles,
    [SELECTED_ID_KEY]: null,
    [SELECTED_TITLE_KEY]: null,
  });
  await signOutFromGoogle();
}

export { signInWithGoogle };

// Retained for backward-compatible imports. No server-side shared secret.
export async function saveSyncConfig() {
  return getSyncConfig();
}

const normalize = (value) => String(value ?? '').trim().toLocaleLowerCase('ru');
const priority = { running: 3, paused: 2, idle: 1 };

function pickLocalProject(candidates, remoteId) {
  return [...candidates].sort((a, b) =>
    (priority[b.status] ?? 0) - (priority[a.status] ?? 0) ||
    Number(b.id === remoteId) - Number(a.id === remoteId)
  )[0];
}

export async function syncTimeEntries() {
  const config = await getSyncConfig();
  if (!config) throw new Error('Подключите Google Таблицу');
  const state = await chrome.storage.local.get([
    PROJECTS_KEY,
    ENTRIES_KEY,
    DELETED_ENTRIES_KEY,
    DELETED_RECORDS_KEY,
    DELETED_PROJECTS_KEY,
    DELETED_PROJECTS_HISTORY_KEY,
    MIGRATED_KEY,
  ]);
  const localProjects = state[PROJECTS_KEY] ?? [];
  const localEntries = state[ENTRIES_KEY] ?? [];
  const deletedEntryIds = state[DELETED_ENTRIES_KEY] ?? [];
  const deletedEntryRecords = state[DELETED_RECORDS_KEY] ?? [];
  const deletedProjects = state[DELETED_PROJECTS_KEY] ?? [];

  // On first migration send all existing entries; afterwards send pending only.
  const toSend = state[MIGRATED_KEY] === true
    ? localEntries.filter((entry) => entry.syncStatus !== 'synced')
    : localEntries;

  const result = await syncSheetData(config.spreadsheetId, {
    action: 'sync',
    protocolVersion: 4,
    projects: localProjects.map((item) => ({
      id: item.id,
      remoteProjectId: item.remoteProjectId ?? null,
      name: item.name,
      previousName: item.previousName ?? null,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      syncStatus: item.syncStatus ?? 'synced',
    })),
    entries: toSend,
    deletedEntryIds,
    deletedEntryRecords: deletedEntryRecords.filter((entry) => deletedEntryIds.includes(entry.id)),
    deletedProjects,
  });

  // Local state may have changed while the request was running.
  const latest = await chrome.storage.local.get([
    PROJECTS_KEY,
    ENTRIES_KEY,
    DELETED_ENTRIES_KEY,
    DELETED_RECORDS_KEY,
    DELETED_PROJECTS_KEY,
    DELETED_PROJECTS_HISTORY_KEY,
  ]);
  const currentProjects = latest[PROJECTS_KEY] ?? [];
  const currentEntries = latest[ENTRIES_KEY] ?? [];
  // Only acknowledge IDs that the Sheets API verified absent. In particular,
  // never clear the queue just because the ID was included in our request.
  const returnedEntryIds = new Set(result.entries.map((entry) => entry.id));
  const ackDeletedEntries = new Set(
    (result.deletedIds ?? []).filter((id) => !returnedEntryIds.has(id))
  );
  const ackDeletedProjects = new Set(result.deletedProjectIds);
  const newDeletedEntries = (latest[DELETED_ENTRIES_KEY] ?? [])
    .filter((id) => !ackDeletedEntries.has(id));
  const excludedEntries = new Set(newDeletedEntries);
  const pendingDeletedRecords = (latest[DELETED_RECORDS_KEY] ?? [])
    .filter((entry) => excludedEntries.has(entry.id));

  const pendingTombstones = latest[DELETED_PROJECTS_KEY] ?? [];
  const deletionHistory = latest[DELETED_PROJECTS_HISTORY_KEY] ?? [];
  const deletionGuards = new Map();
  for (const item of [...deletionHistory, ...pendingTombstones]) {
    deletionGuards.set(item.id, item);
  }

  // Match project IDs first. A name fallback protects legacy projects which
  // were originally synchronized under a different server ID. The fallback
  // is disabled when the user has explicitly created a NEW local project
  // with the same name and a different ID.
  const matchesDeletedProject = (remote, tombstone) => {
    if (remote.id === tombstone.id ||
        (tombstone.remoteProjectId && remote.id === tombstone.remoteProjectId)) {
      return true;
    }
    const oldNames = [tombstone.name, tombstone.previousName]
      .filter(Boolean).map(normalize);
    if (!oldNames.includes(normalize(remote.name))) return false;
    return !currentProjects.some((local) =>
      local.id !== tombstone.id &&
      local.id !== tombstone.remoteProjectId &&
      normalize(local.name) === normalize(remote.name));
  };

  const isDeletedRemoteProject = (remote) => [...deletionGuards.values()]
    .some((item) => matchesDeletedProject(remote, item));

  const hiddenRemoteProjectIds = new Set(
    result.projects.filter(isDeletedRemoteProject).map((item) => item.id)
  );

  // If a previously acknowledged project reappears (for example, from a
  // legacy spreadsheet row), queue a new deletion instead of restoring it.
  const historyRequeues = deletionHistory.flatMap((tombstone) => {
    const remote = result.projects.find((item) => matchesDeletedProject(item, tombstone));
    if (!remote || pendingTombstones.some((item) => item.id === tombstone.id)) return [];
    return [{ ...tombstone, remoteProjectId: remote.id }];
  });

  // Keep tombstones until the response confirms the project is absent.
  // A server acknowledgement alone isn't enough if it also returns the
  // same project in its refreshed registry.
  const newDeletedProjects = [
    ...pendingTombstones.filter((item) =>
      !ackDeletedProjects.has(item.id) ||
      result.projects.some((remote) => matchesDeletedProject(remote, item))),
    ...historyRequeues,
  ];
  const unresolvedDeletes = newDeletedProjects.filter((item) =>
    result.projects.some((remote) => matchesDeletedProject(remote, item))
  );
  const excludedProjectIds = new Set(
    [...deletionGuards.values()].flatMap((item) =>
      [item.id, item.remoteProjectId].filter(Boolean))
  );

  const remoteToLocal = new Map();
  const localToCanonical = new Map();
  const mergedProjects = new Map();

  for (const remote of result.projects) {
    if (isDeletedRemoteProject(remote)) continue;

    const matches = currentProjects.filter((local) =>
      local.id === remote.id ||
      local.remoteProjectId === remote.id ||
      normalize(local.name) === normalize(remote.name)
    );
    const local = pickLocalProject(matches, remote.id);
    const canonicalId = local?.id ?? remote.id;
    remoteToLocal.set(remote.id, canonicalId);
    for (const item of matches) localToCanonical.set(item.id, canonicalId);

    const sent = localProjects.find((item) => item.id === canonicalId);
    const changedDuringRequest = local && sent && local.updatedAt !== sent.updatedAt;
    const locallyPending = local?.syncStatus === 'pending' && changedDuringRequest;

    mergedProjects.set(canonicalId, {
      ...local,
      id: canonicalId,
      remoteProjectId: remote.id,
      name: locallyPending ? local.name : remote.name,
      createdAt: local?.createdAt ?? remote.createdAt ?? new Date().toISOString(),
      updatedAt: locallyPending ? local.updatedAt : (remote.updatedAt ?? local?.updatedAt),
      syncStatus: locallyPending ? 'pending' : 'synced',
      previousName: locallyPending ? local.previousName : null,
      status: local?.status ?? 'idle',
      startedAt: local?.startedAt ?? null,
      sessionStartedAt: local?.sessionStartedAt ?? null,
      sessionId: local?.sessionId ?? null,
      taskDescription: local?.taskDescription ?? '',
      segments: local?.segments ?? [],
    });
  }

  // Preserve projects created locally during the network request.
  for (const local of currentProjects) {
    const mappedId = localToCanonical.get(local.id) ?? local.id;
    if (!mergedProjects.has(mappedId)) {
      mergedProjects.set(mappedId, { ...local });
    }
  }

  const resolveId = (id) => remoteToLocal.get(id) ?? localToCanonical.get(id) ?? id;
  const remoteEntries = result.entries
    .filter((entry) => !excludedEntries.has(entry.id))
    .filter((entry) => !excludedProjectIds.has(entry.projectId) &&
      !hiddenRemoteProjectIds.has(entry.projectId) &&
      ![...deletionGuards.values()].some((item) =>
        [item.name, item.previousName].some((name) =>
          name && normalize(name) === normalize(entry.projectName) &&
          !currentProjects.some((local) =>
            local.id !== item.id && local.id !== item.remoteProjectId &&
            normalize(local.name) === normalize(name)))))
    .map((entry) => ({
      ...entry,
      projectId: resolveId(entry.projectId),
      syncStatus: 'synced',
    }));
  const remoteIds = new Set(remoteEntries.map((entry) => entry.id));
  const sentIds = new Set(toSend.map((entry) => entry.id));
  const pendingDuringRequest = currentEntries
    .filter((entry) => entry.syncStatus !== 'synced' &&
      !sentIds.has(entry.id) && !excludedEntries.has(entry.id) &&
      !remoteIds.has(entry.id))
    .filter((entry) => !excludedProjectIds.has(entry.projectId) &&
      !hiddenRemoteProjectIds.has(entry.projectId) &&
      ![...deletionGuards.values()].some((item) =>
        [item.name, item.previousName].some((name) =>
          name && normalize(name) === normalize(entry.projectName) &&
          !currentProjects.some((local) =>
            local.id !== item.id && local.id !== item.remoteProjectId &&
            normalize(local.name) === normalize(name)))))
    .map((entry) => ({ ...entry, projectId: resolveId(entry.projectId) }));

  const mergedEntries = [...remoteEntries, ...pendingDuringRequest];
  const totals = new Map();
  for (const entry of mergedEntries) {
    totals.set(entry.projectId, (totals.get(entry.projectId) ?? 0) + entry.durationMs);
  }

  // If the server returns a new project generated by manual spreadsheet edits,
  // it appears here with status idle.
  const projectsToSave = [...mergedProjects.values()].map((project) => ({
    ...project,
    totalMs: totals.get(project.id) ?? 0,
  }));

  const selected = (await chrome.storage.local.get(SELECTED_ID_KEY))[SELECTED_ID_KEY];
  if (selected !== config.spreadsheetId) {
    throw new Error('Таблица была изменена во время синхронизации.');
  }
  await chrome.storage.local.set({
    [PROJECTS_KEY]: projectsToSave,
    [ENTRIES_KEY]: mergedEntries,
    [DELETED_ENTRIES_KEY]: newDeletedEntries,
    [DELETED_RECORDS_KEY]: pendingDeletedRecords,
    [DELETED_PROJECTS_KEY]: newDeletedProjects,
    [DELETED_PROJECTS_HISTORY_KEY]: deletionHistory,
    [MIGRATED_KEY]: true,
  });

  if (newDeletedEntries.some((id) => deletedEntryIds.includes(id))) {
    throw new Error('Удаление сессии не подтверждено Google Sheets. ' +
      'Изменение сохранено локально, повторная синхронизация будет выполнена автоматически.');
  }

  if (unresolvedDeletes.length > 0) {
    throw new Error('Google Sheets снова вернул удалённый проект. ' +
      'Удаление сохранено локально и будет повторено автоматически.');
  }

  return {
    uploaded: result.uploaded,
    deleted: result.deleted,
    createdTabs: result.createdTabs,
    received: result.entries.length,
    deletedProjects: result.deletedProjectIds.length,
  };
}

export function requestSync() {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'TIME_TRACKER_SYNC_NOW' }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!response?.ok) {
        reject(new Error(response?.error || 'Ошибка фоновой синхронизации'));
      } else {
        resolve(response.data);
      }
    });
  });
}
