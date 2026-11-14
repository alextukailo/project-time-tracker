import { Spinner } from '@/shared/ui/Spinner';
import { useState } from 'react';

export function ProjectActions({ project, onRename, onDelete, disabled }) {
  const [isEditing, setIsEditing] = useState(false);
  const [name, setName] = useState(project.name);
  const [error, setError] = useState('');
  const [pendingAction, setPendingAction] = useState(null);
  const busy = disabled || pendingAction !== null;

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setError('');
    setPendingAction('rename');
    try {
      await onRename(project.id, name);
      setIsEditing(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setPendingAction(null);
    }
  };

  const handleDelete = async () => {
    if (project.status !== 'idle') return;
    if (!window.confirm(
      `Удалить проект «${project.name}» со всей историей сессий?\n\n` +
      'Записи также будут удалены из Google Таблиц. Это действие нельзя отменить.'
    )) return;

    if (busy) return;
    setError('');
    setPendingAction('delete');
    try {
      await onDelete(project.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <div className="mt-3">
      <div className="flex gap-3 text-[11px]">
        <button type="button" disabled={busy}
          onClick={() => { setName(project.name); setError(''); setIsEditing((value) => !value); }}
          className="text-gray-600 underline underline-offset-2 disabled:opacity-40">
          {isEditing ? 'Скрыть редактирование' : 'Переименовать'}
        </button>
        <button type="button" disabled={busy || project.status !== 'idle'}
          aria-busy={pendingAction === 'delete'}
          onClick={handleDelete}
          title={project.status !== 'idle' ? 'Сначала завершите сессию' : 'Удалить проект и его сессии'}
          className="text-red-600 underline underline-offset-2 disabled:opacity-40">
          <span className="inline-flex items-center gap-1">
            {pendingAction === 'delete' && <Spinner />}
            Удалить проект
          </span>
        </button>
      </div>

      {isEditing && (
        <form onSubmit={submit} className="mt-3 flex gap-2">
          <input type="text" maxLength={100} autoFocus value={name}
            onChange={(event) => setName(event.target.value)}
            aria-label="Новое название проекта"
            className="min-w-0 flex-1 rounded-lg border border-black/15 px-3 py-2 text-xs outline-none focus:border-brand" />
          <button type="submit" disabled={busy || !name.trim()}
            aria-busy={pendingAction === 'rename'}
            className="rounded-lg bg-brand px-3 py-2 text-xs font-semibold disabled:opacity-40">
            <span className="inline-flex items-center gap-1">
              {pendingAction === 'rename' && <Spinner />}
              Сохранить
            </span>
          </button>
        </form>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}
