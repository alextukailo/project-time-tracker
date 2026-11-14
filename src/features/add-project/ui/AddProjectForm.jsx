import { Spinner } from '@/shared/ui/Spinner';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createProject } from '@/entities/project';

export function AddProjectForm({ onCreated }) {
  const [name, setName] = useState('');
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: createProject,
    scope: { id: 'project-storage' },
    onSuccess: async () => {
      setName('');
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      await onCreated?.();
    },
  });

  return (
    <form onSubmit={(event) => {
      event.preventDefault();
      if (name.trim()) mutation.mutate(name);
    }}>
      <label htmlFor="project-name" className="mb-2 block text-xs font-bold uppercase">
        Новый проект
      </label>
      <div className="flex gap-2">
        <input id="project-name" type="text" value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Название проекта..." maxLength={100}
          className="min-w-0 flex-1 rounded-lg border border-black/15 px-3 py-3 text-sm outline-none focus:border-brand" />
        <button type="submit" disabled={!name.trim() || mutation.isPending}
          aria-busy={mutation.isPending}
          className="rounded-lg bg-brand px-4 text-xl font-bold disabled:opacity-40"
          aria-label="Добавить проект">
          {mutation.isPending ? <Spinner size="md" /> : '+'}
        </button>
      </div>
      {mutation.isError && <p role="alert" className="mt-2 text-xs text-red-600">{mutation.error.message}</p>}
    </form>
  );
}
