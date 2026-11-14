export function formatDuration(milliseconds) {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  return [hours, minutes, remainingSeconds]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

export function getLocalDate(timestamp) {
  const date = new Date(timestamp);

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

export function getWorkSegments(project, now = Date.now()) {
  const segments = [...(project.segments ?? [])];

  if (
    project.status === 'running' &&
    typeof project.startedAt === 'number' &&
    now > project.startedAt
  ) {
    segments.push({
      startMs: project.startedAt,
      endMs: now,
    });
  }

  return segments;
}

export function getSessionElapsedMs(project, now = Date.now()) {
  return getWorkSegments(project, now).reduce(
    (total, segment) =>
      total + Math.max(0, segment.endMs - segment.startMs),
    0
  );
}

export function splitSegmentsByDay(segments) {
  const dailyEntries = new Map();

  for (const segment of segments) {
    let cursor = segment.startMs;

    while (cursor < segment.endMs) {
      const date = getLocalDate(cursor);

      // Next midnight in the computer's local time zone
      const midnight = new Date(cursor);
      midnight.setHours(24, 0, 0, 0);

      const chunkEnd = Math.min(
        segment.endMs,
        midnight.getTime()
      );

      const durationMs = chunkEnd - cursor;

      if (durationMs <= 0) {
        throw new Error('Не удалось разделить время по дням');
      }

      const existing = dailyEntries.get(date);

      if (existing) {
        existing.durationMs += durationMs;
        existing.endedAt = new Date(chunkEnd).toISOString();
      } else {
        dailyEntries.set(date, {
          date,
          startedAt: new Date(cursor).toISOString(),
          endedAt: new Date(chunkEnd).toISOString(),
          durationMs,
        });
      }

      cursor = chunkEnd;
    }
  }

  return [...dailyEntries.values()].sort(
    (a, b) => a.date.localeCompare(b.date)
  );
}
