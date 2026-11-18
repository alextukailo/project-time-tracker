

const PROJECTS_KEY = 'projects';
const ENTRIES_KEY = 'timeEntries';
const DELETED_KEY = 'deletedEntryIds';
const DELETED_RECORDS_KEY = 'deletedEntryRecords';

// ----------------------------------------
// Get all completed time entries
// ----------------------------------------

export async function getTimeEntries() {
  const state = await chrome.storage.local.get(
    ENTRIES_KEY
  );

  return state[ENTRIES_KEY] ?? [];
}

// ----------------------------------------
// Delete an entire tracking session
// ----------------------------------------

export async function deleteTimeSession(sessionId) {
  if (!sessionId) {
    throw new Error('Не указан ID сессии');
  }

  const state = await chrome.storage.local.get([
    PROJECTS_KEY,
    ENTRIES_KEY,
    DELETED_KEY,
    DELETED_RECORDS_KEY,
  ]);

  const projects = state[PROJECTS_KEY] ?? [];
  const entries = state[ENTRIES_KEY] ?? [];
  const deletedIds = state[DELETED_KEY] ?? [];
  const deletedRecords = state[DELETED_RECORDS_KEY] ?? [];

  // A session may have multiple entries when
  // it crosses midnight.
  const sessionEntries = entries.filter(
    (entry) => (entry.sessionId ?? entry.id) === sessionId
  );

  if (sessionEntries.length === 0) {
    return {
      deleted: 0,
      sessionId,
    };
  }

  // ----------------------------------------
  // 1. Collect IDs for remote deletion
  // ----------------------------------------

  const sessionEntryIds = sessionEntries.map(
    (entry) => entry.id
  );

  // The backend uses these IDs to find and delete
  // the corresponding rows in Google Sheets.
  const pendingDeletions = [
    ...new Set([
      ...deletedIds,
      ...sessionEntryIds,
    ]),
  ];

  // Keep the original values until Sheets confirms the row was really removed.
  // They allow safe recovery when Google Sheets lost a row's developer metadata.
  const recordsById = new Map(deletedRecords.map((entry) => [entry.id, entry]));
  for (const entry of sessionEntries) recordsById.set(entry.id, { ...entry });

  // ----------------------------------------
  // 2. Remove entries from local history
  // ----------------------------------------

  const remainingEntries = entries.filter(
    (entry) => (entry.sessionId ?? entry.id) !== sessionId
  );

  // ----------------------------------------
  // 3. Calculate removed tracked time
  // ----------------------------------------

  const removedTotals = new Map();

  for (const entry of sessionEntries) {
    const previous =
      removedTotals.get(entry.projectId) ?? 0;

    removedTotals.set(
      entry.projectId,
      previous + entry.durationMs
    );
  }

  // ----------------------------------------
  // 4. Update project totals
  // ----------------------------------------

  const updatedProjects = projects.map((project) => {
    const removedMs =
      removedTotals.get(project.id) ?? 0;

    return {
      ...project,

      totalMs: Math.max(
        0,
        (project.totalMs ?? 0) - removedMs
      ),
    };
  });

  // ----------------------------------------
  // 5. Save changes
  // ----------------------------------------

  // Local deletion and its remote deletion queue
  // are persisted in the same storage operation.
  await chrome.storage.local.set({
    [PROJECTS_KEY]: updatedProjects,
    [ENTRIES_KEY]: remainingEntries,
    [DELETED_KEY]: pendingDeletions,
    [DELETED_RECORDS_KEY]: [...recordsById.values()],
  });

  return {
    deleted: sessionEntries.length,
    sessionId,
    deletedEntryIds: sessionEntryIds,
  };
}
