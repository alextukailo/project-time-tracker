

import {
  syncTimeEntries,
  getSyncConfig,
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

  activeSync = getSyncConfig()
    .then((config) => config ? syncTimeEntries() : { skipped: true })
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
  const { projects = [] } = await chrome.storage.local.get('projects');
  const running = projects.some((project) => project.status === 'running');
  const paused = projects.some((project) => project.status === 'paused');
  const state = running ? 'active' : paused ? 'paused' : 'idle';
  await Promise.all([
    chrome.action.setIcon({ path: {
      16: `icons/${state}-16.png`,
      32: `icons/${state}-32.png`,
    } }),
    chrome.action.setBadgeText({ text: running ? 'ON' : paused ? 'II' : '' }),
    chrome.action.setBadgeBackgroundColor({ color: '#F1BC00' }),
    chrome.action.setTitle({
      title: running ? 'Трекер времени — В работе' : paused ? 'Трекер времени — На паузе' : 'Трекер времени',
    }),
  ]);
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
