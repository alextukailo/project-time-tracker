import { Spinner } from '@/shared/ui/Spinner';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { startProject, pauseProject, stopProject } from '@/entities/project';

export function TimerControls({ project, onStopped }) {
  const [showTaskInput, setShowTaskInput] = useState(false);
  const [description, setDescription] = useState('');
  const queryClient = useQueryClient();

  const mutation = useMutation({
    scope: { id: 'project-storage' },
    mutationFn: ({ action, taskDescription }) => {
      if (action === 'start') return startProject(project.id, taskDescription);
      if (action === 'pause') return pauseProject(project.id);
      if (action === 'stop') return stopProject(project.id);
      throw new Error('Неизвестное действие');
    },
    onSuccess: async (_, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['projects'] }),
        queryClient.invalidateQueries({ queryKey: ['timeEntries'] }),
      ]);
      if (variables.action === 'start') {
        setShowTaskInput(false);
        setDescription('');
      }
      if (variables.action === 'stop') await onStopped?.();
    },
  });

  const isRunning = project.status === 'running';
  const isPaused = project.status === 'paused';
  const isIdle = project.status === 'idle';

  const handleStart = () => {
    if (mutation.isPending) return;
    if (isPaused) {
      mutation.mutate({ action: 'start' });
    } else {
      setShowTaskInput(true);
    }
  };

  return (
    <>
      <div className="grid grid-cols-3 gap-2">
        <button type="button" disabled={isRunning || mutation.isPending}
          aria-busy={mutation.isPending && mutation.variables?.action === 'start'}
          onClick={handleStart}
          className="rounded-lg bg-brand px-2 py-2 text-xs font-semibold disabled:opacity-40">
          {mutation.isPending && mutation.variables?.action === 'start'
            ? <Spinner />
            : (isPaused ? 'Продолжить' : 'Старт')}
        </button>
        <button type="button" disabled={!isRunning || mutation.isPending}
          aria-busy={mutation.isPending && mutation.variables?.action === 'pause'}
          onClick={() => mutation.mutate({ action: 'pause' })}
          className="rounded-lg bg-gray-100 px-2 py-2 text-xs font-semibold disabled:opacity-40">
          {mutation.isPending && mutation.variables?.action === 'pause'
            ? <Spinner /> : 'Пауза'}
        </button>
        <button type="button" disabled={isIdle || mutation.isPending}
          aria-busy={mutation.isPending && mutation.variables?.action === 'stop'}
          onClick={() => mutation.mutate({ action: 'stop' })}
          className="rounded-lg border border-black/15 px-2 py-2 text-xs font-semibold disabled:opacity-40">
          {mutation.isPending && mutation.variables?.action === 'stop'
            ? <Spinner /> : 'Стоп'}
        </button>
      </div>

      {!isIdle && project.taskDescription && (
        <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-gray-700">
          <span className="font-semibold">Задача:</span> {project.taskDescription}
        </div>
      )}

      {showTaskInput && isIdle && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate({ action: 'start', taskDescription: description });
          }}
          className="mt-3 rounded-lg border border-brand/60 bg-amber-50 p-3"
        >
          <label className="mb-2 block text-xs font-semibold" htmlFor={`task-${project.id}`}>
            Описание задачи для новой сессии
          </label>
          <textarea
            id={`task-${project.id}`}
            rows={3}
            maxLength={500}
            autoFocus
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Что планируете делать? (необязательно)"
            className="w-full resize-y rounded-lg border border-black/15 bg-white px-3 py-2 text-xs outline-none focus:border-brand"
          />
          <div className="mt-2 flex gap-2">
            <button type="submit" disabled={mutation.isPending}
              aria-busy={mutation.isPending}
              className="flex-1 rounded-lg bg-brand px-3 py-2 text-xs font-semibold disabled:opacity-50">
              <span className="inline-flex items-center justify-center gap-2">
                {mutation.isPending && <Spinner />}
                {mutation.isPending ? 'Запускаем...' : 'Начать сессию'}
              </span>
            </button>
            <button type="button" disabled={mutation.isPending}
              onClick={() => setShowTaskInput(false)}
              className="rounded-lg border border-black/15 px-3 py-2 text-xs">
              Отмена
            </button>
          </div>
        </form>
      )}

      {mutation.isError && (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {mutation.error.message}
        </p>
      )}
    </>
  );
}
