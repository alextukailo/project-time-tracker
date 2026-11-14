/* eslint-disable no-undef */

import {
  getWorkSegments,
  splitSegmentsByDay,
} from '@/shared/lib/time';

const PROJECTS_KEY = 'projects';
const ENTRIES_KEY = 'timeEntries';
const DELETED_ENTRIES_KEY = 'deletedEntryIds';
const DELETED_PROJECTS_KEY = 'deletedProjects';
const DELETED_PROJECTS_HISTORY_KEY = 'deletedProjectsHistory';

const cleanName = (name) => String(name ?? '').trim();
const normalizedName = (name) => cleanName(name).toLocaleLowerCase('ru');

function validateProjectName(name) {
  const trimmedName = cleanName(name);
  if (!trimmedName || trimmedName.length > 100 || /^[=+@-]/.test(trimmedName)) {
    throw new Error('Введите корректное название проекта (до 100 символов, без = + @ - в начале)');
  }
  return trimmedName;
}

export async function getProjects() {
  const result = await chrome.storage.local.get(PROJECTS_KEY);
  return result[PROJECTS_KEY] ?? [];
}

export async function createProject(name) {
  const trimmedName = validateProjectName(name);

  const projects = await getProjects();
  if (projects.some((project) => normalizedName(project.name) === normalizedName(trimmedName))) {
    throw new Error('Проект с таким названием уже существует');
  }

  const now = new Date().toISOString();
  const project = {
    id: crypto.randomUUID(),
    name: trimmedName,
    createdAt: now,
    updatedAt: now,
    syncStatus: 'pending',
    status: 'idle',
    totalMs: 0,
    sessionId: null,
    sessionStartedAt: null,
    startedAt: null,
    taskDescription: '',
    segments: [],
  };

  await chrome.storage.local.set({ [PROJECTS_KEY]: [...projects, project] });
  return project;
}

export async function renameProject({ projectId, name }) {
  const trimmedName = validateProjectName(name);

  const state = await chrome.storage.local.get([PROJECTS_KEY, ENTRIES_KEY]);
  const projects = state[PROJECTS_KEY] ?? [];
  const entries = state[ENTRIES_KEY] ?? [];
  const project = projects.find((item) => item.id === projectId);

  if (!project) throw new Error('Проект не найден');
  if (projects.some((item) => item.id !== projectId && normalizedName(item.name) === normalizedName(trimmedName))) {
    throw new Error('Проект с таким названием уже существует');
  }
  if (project.name === trimmedName) return project;

  const updatedAt = new Date().toISOString();
  const updatedProjects = projects.map((item) => item.id === projectId
    ? { ...item, name: trimmedName, previousName: item.previousName ?? item.name, updatedAt, syncStatus: 'pending' }
    : item);
  const updatedEntries = entries.map((entry) => entry.projectId === projectId
    ? { ...entry, projectName: trimmedName }
    : entry);

  await chrome.storage.local.set({
    [PROJECTS_KEY]: updatedProjects,
    [ENTRIES_KEY]: updatedEntries,
  });
  return updatedProjects.find((item) => item.id === projectId);
}

export async function deleteProject(projectId) {
  const state = await chrome.storage.local.get([
    PROJECTS_KEY, ENTRIES_KEY, DELETED_ENTRIES_KEY,
    DELETED_PROJECTS_KEY, DELETED_PROJECTS_HISTORY_KEY,
  ]);

  const projects = state[PROJECTS_KEY] ?? [];
  const entries = state[ENTRIES_KEY] ?? [];
  const project = projects.find((item) => item.id === projectId);
  if (!project) throw new Error('Проект не найден');
  if (project.status !== 'idle') {
    throw new Error('Сначала завершите текущую сессию проекта');
  }

  const removed = entries.filter((entry) => entry.projectId === projectId);
  const pendingDeletions = new Set(state[DELETED_ENTRIES_KEY] ?? []);
  removed.forEach((entry) => pendingDeletions.add(entry.id));

  const deletedProjects = state[DELETED_PROJECTS_KEY] ?? [];
  const tombstone = {
    id: projectId,
    remoteProjectId: project.remoteProjectId ?? null,
    name: project.name,
    previousName: project.previousName ?? null,
  };

  await chrome.storage.local.set({
    [PROJECTS_KEY]: projects.filter((item) => item.id !== projectId),
    [ENTRIES_KEY]: entries.filter((entry) => entry.projectId !== projectId),
    [DELETED_ENTRIES_KEY]: [...pendingDeletions],
    [DELETED_PROJECTS_KEY]: [
      ...deletedProjects.filter((item) => item.id !== projectId),
      tombstone,
    ],
    // Keep a durable ID/name tombstone after the server acknowledges deletion.
    // This prevents stale spreadsheet rows from resurrecting the project.
    [DELETED_PROJECTS_HISTORY_KEY]: [
      ...(state[DELETED_PROJECTS_HISTORY_KEY] ?? []).filter((item) => item.id !== projectId),
      tombstone,
    ],
  });

  return { projectId, deletedSessions: new Set(removed.map((e) => e.sessionId)).size };
}

export async function startProject(projectId, taskDescription = '') {
  const projects = await getProjects();
  const target = projects.find((p) => p.id === projectId);
  if (!target) throw new Error('Проект не найден');
  if (target.status === 'running') return target;

  const now = Date.now();
  const description = String(taskDescription ?? '').trim();
  if (description.length > 500) {
    throw new Error('Описание задачи не может превышать 500 символов');
  }

  const updatedProjects = projects.map((project) => {
    if (project.id === projectId) {
      const isResuming = project.status === 'paused';
      return {
        ...project,
        status: 'running',
        startedAt: now,
        sessionId: isResuming && project.sessionId ? project.sessionId : crypto.randomUUID(),
        sessionStartedAt: isResuming && project.sessionStartedAt
          ? project.sessionStartedAt
          : new Date(now).toISOString(),
        taskDescription: isResuming ? (project.taskDescription ?? '') : description,
        segments: isResuming ? (project.segments ?? []) : [],
      };
    }
    if (project.status === 'running') {
      return {
        ...project,
        status: 'paused',
        startedAt: null,
        segments: getWorkSegments(project, now),
      };
    }
    return project;
  });

  await chrome.storage.local.set({ [PROJECTS_KEY]: updatedProjects });
  return updatedProjects.find((p) => p.id === projectId);
}

export async function pauseProject(projectId) {
  const projects = await getProjects();
  const project = projects.find((p) => p.id === projectId);
  if (!project) throw new Error('Проект не найден');
  if (project.status !== 'running') return project;

  const now = Date.now();
  const updatedProjects = projects.map((item) => item.id === projectId
    ? {
        ...item,
        status: 'paused',
        startedAt: null,
        segments: getWorkSegments(item, now),
      }
    : item);

  await chrome.storage.local.set({ [PROJECTS_KEY]: updatedProjects });
  return updatedProjects.find((p) => p.id === projectId);
}

export async function stopProject(projectId) {
  const state = await chrome.storage.local.get([PROJECTS_KEY, ENTRIES_KEY]);
  const projects = state[PROJECTS_KEY] ?? [];
  const entries = state[ENTRIES_KEY] ?? [];
  const project = projects.find((p) => p.id === projectId);
  if (!project) throw new Error('Проект не найден');
  if (project.status === 'idle') return null;

  const now = Date.now();
  const segments = getWorkSegments(project, now);
  const dailyEntries = splitSegmentsByDay(segments);
  const sessionId = project.sessionId ?? crypto.randomUUID();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const newEntries = dailyEntries.map((entry) => ({
    id: crypto.randomUUID(),
    sessionId,
    projectId: project.id,
    projectName: project.name,
    taskDescription: project.taskDescription ?? '',
    date: entry.date,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    durationMs: entry.durationMs,
    timeZone,
    syncStatus: 'pending',
    createdAt: new Date(now).toISOString(),
  }));

  const sessionDurationMs = newEntries.reduce((total, entry) => total + entry.durationMs, 0);
  const updatedProjects = projects.map((item) => item.id === projectId
    ? {
        ...item,
        status: 'idle',
        totalMs: (item.totalMs ?? 0) + sessionDurationMs,
        sessionId: null,
        sessionStartedAt: null,
        startedAt: null,
        taskDescription: '',
        segments: [],
      }
    : item);

  await chrome.storage.local.set({
    [PROJECTS_KEY]: updatedProjects,
    [ENTRIES_KEY]: [...entries, ...newEntries],
  });

  return { sessionId, durationMs: sessionDurationMs, entries: newEntries };
}
