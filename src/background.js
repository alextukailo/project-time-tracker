
/* eslint-disable no-undef */

import {
  syncTimeEntries,
} from './features/google-sheets/api/googleSheetsApi';

const SYNC_ALARM = 'time-tracker-sync';
const SYNC_MESSAGE = 'TIME_TRACKER_SYNC_NOW';

let activeSync = null;

// ----------------------------------------
// Synchronization
// ----------------------------------------

function runSync(source = 'background') {
  if (activeSync) {
    return activeSync;
  }

  activeSync = syncTimeEntries()
    .then((result) => {
      console.log(
        `[Time Tracker] Sync completed: ${source}`,
        result
      );

      return result;
    })
    .catch((error) => {
      console.error(
        `[Time Tracker] Sync failed: ${source}`,
        error
      );

      throw error;
    })
    .finally(() => {
      activeSync = null;
    });

  return activeSync;
}

// ----------------------------------------
// Alarm
// ----------------------------------------

async function ensureSyncAlarm() {
  const existing = await chrome.alarms.get(SYNC_ALARM);

  if (existing) {
    return;
  }

  await chrome.alarms.create(SYNC_ALARM, {
    periodInMinutes: 1,
  });
}

// ----------------------------------------
// Toolbar badge
// ----------------------------------------

async function updateBadge() {
  const { projects = [] } =
    await chrome.storage.local.get('projects');

  const running = projects.some(
    (project) => project.status === 'running'
  );

  const paused = projects.some(
    (project) => project.status === 'paused'
  );

  const text = running
    ? 'ON'
    : paused
      ? 'II'
      : '';

  await chrome.action.setBadgeText({ text });

  if (text) {
    await chrome.action.setBadgeBackgroundColor({
      color: running ? '#F1BC00' : '#777777',
    });
  }
}

// ----------------------------------------
// Extension lifecycle
// ----------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  void ensureSyncAlarm();
  void updateBadge();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureSyncAlarm();
  void updateBadge();
});

// ----------------------------------------
// Background synchronization
// ----------------------------------------

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== SYNC_ALARM) {
    return;
  }

  void runSync('alarm').catch(() => {});
});

// ----------------------------------------
// Messages from popup
// ----------------------------------------

chrome.runtime.onMessage.addListener(
  (message, sender, sendResponse) => {
    if (message?.type !== SYNC_MESSAGE) {
      return false;
    }

    runSync('popup')
      .then((result) => {
        sendResponse({
          ok: true,
          data: result,
        });
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error.message,
        });
      });

    return true;
  }
);

// ----------------------------------------
// Storage changes
// ----------------------------------------

chrome.storage.onChanged.addListener(
  (changes, areaName) => {
    if (areaName !== 'local') {
      return;
    }

    if (changes.projects) {
      void updateBadge();
    }
  }
);

// Restore the alarm if Chrome removed it.
void ensureSyncAlarm();
void updateBadge();
