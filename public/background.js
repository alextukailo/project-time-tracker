async function updateToolbarIcon(projects = []) {
  const isRunning = projects.some(
    (project) => project.status === 'running'
  );

  const isPaused = projects.some(
    (project) => project.status === 'paused'
  );

  let state = 'idle';
  let badge = '';
  let title = 'Трекер времени';

  if (isRunning) {
    state = 'active';
    badge = '▶';
    title = 'Трекер времени — В работе';
  } else if (isPaused) {
    state = 'paused';
    badge = '⏸';
    title = 'Трекер времени — На паузе';
  }

  await Promise.all([
    chrome.action.setIcon({
      path: {
        16: `icons/${state}-16.png`,
        32: `icons/${state}-32.png`,
      },
    }),

    chrome.action.setBadgeText({
      text: badge,
    }),

    chrome.action.setBadgeBackgroundColor({
      color: '#F1BC00',
    }),

    chrome.action.setBadgeTextColor({
      color: '#000000',
    }),

    chrome.action.setTitle({
      title,
    }),
  ]);
}

async function restoreToolbarIcon() {
  const { projects = [] } = await chrome.storage.local.get(
    'projects'
  );

  await updateToolbarIcon(projects);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (!changes.projects) return;

  const projects = changes.projects.newValue ?? [];

  void updateToolbarIcon(projects);
});

chrome.runtime.onInstalled.addListener(() => {
  void restoreToolbarIcon();
});

chrome.runtime.onStartup.addListener(() => {
  void restoreToolbarIcon();
});

void restoreToolbarIcon();
