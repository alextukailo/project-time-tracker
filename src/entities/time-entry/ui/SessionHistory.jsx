import { useState } from 'react';

import { Spinner } from '@/shared/ui/Spinner';
import {
  formatDuration,
  getLocalDate,
} from '@/shared/lib/time';

function formatDate(dateString) {
  const [year, month, day] = dateString
    .split('-')
    .map(Number);

  return new Date(
    year,
    month - 1,
    day,
    12
  ).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'short',
  });
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function SessionHistory({
  entries = [],
  onDeleteSession,
  isDeleting = false,
}) {
  const [confirmSessionId, setConfirmSessionId] = useState(null);
  const grouped = new Map();

  for (const entry of entries) {
    const sessionId = entry.sessionId ?? entry.id;

    if (!grouped.has(sessionId)) {
      grouped.set(sessionId, []);
    }

    grouped.get(sessionId).push(entry);
  }

  const sessions = [...grouped.entries()]
    .map(([id, items]) => ({
      id,
      items: items.sort((a, b) =>
        (a.date ?? '').localeCompare(b.date ?? '')
      ),
      taskDescription: items.find((item) => item.taskDescription)?.taskDescription ?? '',
      durationMs: items.reduce(
        (total, item) => total + item.durationMs,
        0
      ),
      endedAt: Math.max(
        ...items.map((item) =>
          new Date(item.endedAt).getTime()
        )
      ),
    }))
    .sort((a, b) => b.endedAt - a.endedAt);

  if (sessions.length === 0) {
    return null;
  }

  const handleDelete = (sessionId) => {
    // Native confirmation dialogs can be unreliable in an extension popup:
    // the browser may close the popup before the callback completes.
    onDeleteSession?.(sessionId);
    setConfirmSessionId(null);
  };

  return (
    <section className="mt-4 border-t border-black/10 pt-3">
      <h4 className="mb-3 text-xs font-semibold">
        История сессий
      </h4>

      <div className="space-y-3">
        {sessions.map((session, index) => (
          <div
            key={session.id}
            className="rounded-lg bg-gray-50 p-3"
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className="text-xs font-semibold">
                Сессия {sessions.length - index}
              </span>

              <div className="flex items-center gap-3">
                <span className="font-mono text-xs font-semibold">
                  {formatDuration(session.durationMs)}
                </span>

                {confirmSessionId === session.id ? (
                  <div className="flex items-center gap-2" role="group" aria-label="Подтвердить удаление сессии">
                    <button
                      type="button"
                      disabled={isDeleting}
                      aria-busy={isDeleting}
                      onClick={() => handleDelete(session.id)}
                      className="text-xs font-semibold text-red-600 hover:text-red-800 disabled:opacity-40"
                    >
                      <span className="inline-flex items-center gap-1">
                        {isDeleting && <Spinner />}
                        Да, удалить
                      </span>
                    </button>
                    <button
                      type="button"
                      disabled={isDeleting}
                      onClick={() => setConfirmSessionId(null)}
                      className="text-xs text-slate-600 hover:text-black disabled:opacity-40"
                    >
                      Отмена
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={isDeleting}
                    onClick={() => setConfirmSessionId(session.id)}
                    className="text-xs text-red-600 hover:text-red-800 disabled:opacity-40"
                    title="Удалить сессию"
                  >
                    Удалить
                  </button>
                )}
              </div>
            </div>

            {session.taskDescription && (
              <p className="mb-3 whitespace-pre-wrap break-words text-xs text-gray-700">
                <span className="font-semibold">Задача:</span> {session.taskDescription}
              </p>
            )}
            <div className="space-y-2">
              {session.items.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-center justify-between gap-2 text-xs text-gray-600"
                >
                  <div>
                    <div>
                      {formatDate(
                        entry.date ??
                          getLocalDate(
                            new Date(entry.endedAt).getTime()
                          )
                      )}
                    </div>

                    <div className="text-[10px] text-gray-400">
                      {formatTime(entry.startedAt)}
                      {' – '}
                      {formatTime(entry.endedAt)}
                    </div>
                  </div>

                  <span className="font-mono">
                    {formatDuration(entry.durationMs)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
