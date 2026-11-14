import {
  formatDuration,
  getSessionElapsedMs,
} from '@/shared/lib/time';

export function ProjectCard({
  project,
  now,
  children,
}) {
  const sessionMs = getSessionElapsedMs(project, now);
  const totalMs = (project.totalMs ?? 0) + sessionMs;

  const statusLabels = {
    idle: 'Не запущен',
    running: 'В работе',
    paused: 'На паузе',
  };

  const statusColors = {
    idle: 'bg-gray-400',
    running: 'bg-green-600',
    paused: 'bg-brand',
  };

  return (
    <article className="rounded-xl border border-black/10 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-words text-sm font-semibold">
            {project.name}
          </h3>

          <div className="mt-2 flex items-center gap-2">
            <span
              className={`h-2 w-2 rounded-full ${
                statusColors[project.status] ?? 'bg-gray-400'
              }`}
            />

            <span className="text-xs text-gray-500">
              {statusLabels[project.status] ?? 'Не запущен'}
            </span>
          </div>
        </div>

        <div className="shrink-0 text-right">
          <div className="font-mono text-xl font-bold tabular-nums">
            {formatDuration(totalMs)}
          </div>

          <p className="mt-1 text-[10px] text-gray-500">
            Всего времени
          </p>
        </div>
      </div>

      {project.status !== 'idle' && (
        <div className="mt-4 flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2">
          <span className="text-xs text-gray-500">
            Текущая сессия
          </span>

          <span className="font-mono text-sm font-semibold tabular-nums">
            {formatDuration(sessionMs)}
          </span>
        </div>
      )}

      <div className="mt-4">
        {children}
      </div>
    </article>
  );
}
