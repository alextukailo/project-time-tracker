/* eslint-disable no-undef */

import axios from 'axios';

const WEB_APP_URL = import.meta.env.VITE_WEB_APP_URL;
const SYNC_SECRET = import.meta.env.VITE_SYNC_SECRET;

const PROJECTS_KEY = 'projects';
const ENTRIES_KEY = 'timeEntries';
const DELETED_ENTRIES_KEY = 'deletedEntryIds';
const DELETED_PROJECTS_KEY = 'deletedProjects';
const DELETED_PROJECTS_HISTORY_KEY = 'deletedProjectsHistory';
const MIGRATED_KEY = 'dateTabsMigrationV3';

function validateConfig() {
  if (!WEB_APP_URL?.endsWith('/exec')) {
    throw new Error('Проверьте VITE_WEB_APP_URL в .env');
  }
  if (!SYNC_SECRET?.trim()) {
    throw new Error('Проверьте VITE_SYNC_SECRET в .env');
  }
}

export async function getSyncConfig() {
  validateConfig();
  return { configured: true, webAppUrl: WEB_APP_URL };
}

// Kept only for compatibility with existing module imports.
export async function saveSyncConfig() {
  return getSyncConfig();
}

async function postToScript(payload) {
  validateConfig();
  const response = await axios.post(
    WEB_APP_URL,
    JSON.stringify({ ...payload, secret: SYNC_SECRET.trim() }),
    {
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      responseType: 'text',
      timeout: 30000,
    }
  );

  let result;
  try {
    result = typeof response.data === 'string'
      ? JSON.parse(response.data)
      : response.data;
  } catch {
    throw new Error('Неверный ответ Apps Script. Проверьте URL и доступ.');
  }

  if (!result?.ok) throw new Error(result?.error || 'Ошибка синхронизации');
  if (
    result.version !== '4.0.0' ||
    !Array.isArray(result.projects) ||
    !Array.isArray(result.entries) ||
    !Array.isArray(result.deletedProjectIds)
  ) {
    throw new Error('Обновите Apps Script до версии 4.0.0 и опубликуйте новый deployment');
  }
  return result;
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
  validateConfig();
  const state = await chrome.storage.local.get([
    PROJECTS_KEY,
    ENTRIES_KEY,
    DELETED_ENTRIES_KEY,
    DELETED_PROJECTS_KEY,
    DELETED_PROJECTS_HISTORY_KEY,
    MIGRATED_KEY,
  ]);
  const localProjects = state[PROJECTS_KEY] ?? [];
  const localEntries = state[ENTRIES_KEY] ?? [];
  const deletedEntryIds = state[DELETED_ENTRIES_KEY] ?? [];
  const deletedProjects = state[DELETED_PROJECTS_KEY] ?? [];

  // On first migration send all existing entries; afterwards send pending only.
  const toSend = state[MIGRATED_KEY] === true
    ? localEntries.filter((entry) => entry.syncStatus !== 'synced')
    : localEntries;

  const result = await postToScript({
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
    deletedProjects,
  });

  // Local state may have changed while the request was running.
  const latest = await chrome.storage.local.get([
    PROJECTS_KEY,
    ENTRIES_KEY,
    DELETED_ENTRIES_KEY,
    DELETED_PROJECTS_KEY,
    DELETED_PROJECTS_HISTORY_KEY,
  ]);
  const currentProjects = latest[PROJECTS_KEY] ?? [];
  const currentEntries = latest[ENTRIES_KEY] ?? [];
  const ackDeletedEntries = new Set(deletedEntryIds);
  const ackDeletedProjects = new Set(result.deletedProjectIds);
  const newDeletedEntries = (latest[DELETED_ENTRIES_KEY] ?? [])
    .filter((id) => !ackDeletedEntries.has(id));
  const excludedEntries = new Set(newDeletedEntries);

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

  await chrome.storage.local.set({
    [PROJECTS_KEY]: projectsToSave,
    [ENTRIES_KEY]: mergedEntries,
    [DELETED_ENTRIES_KEY]: newDeletedEntries,
    [DELETED_PROJECTS_KEY]: newDeletedProjects,
    [DELETED_PROJECTS_HISTORY_KEY]: deletionHistory,
    [MIGRATED_KEY]: true,
  });

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
