/* eslint-disable react-hooks/purity */


import {
  useCallback,
  useEffect,
  useState,
} from 'react';

import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import {
  getProjects,
  renameProject,
  deleteProject,
  ProjectCard,
} from '@/entities/project';

import {
  getTimeEntries,
  deleteTimeSession,
  SessionHistory,
} from '@/entities/time-entry';

import {
  AddProjectForm,
} from '@/features/add-project';

import {
  TimerControls,
} from '@/features/track-time';

import { ProjectActions } from '@/features/manage-project';
import { GlobalLoadingIndicator } from '@/shared/ui/GlobalLoadingIndicator';

import {
  GoogleSheetsPanel,
  getSyncConfig,
  requestSync,
} from '@/features/google-sheets';

export function TrackerPage() {
  const queryClient = useQueryClient();

  const [now, setNow] = useState(Date.now());
  const [syncWarning, setSyncWarning] = useState('');
  const [activeSyncRequests, setActiveSyncRequests] = useState(0);

  // ----------------------------------------
  // Projects
  // ----------------------------------------

  const {
    data: projects = [],
    isPending: isProjectsPending,
    error: projectsError,
  } = useQuery({
    queryKey: ['projects'],
    queryFn: getProjects,
  });

  // ----------------------------------------
  // Time entries
  // ----------------------------------------

  const {
    data: entries = [],
    isPending: isEntriesPending,
    error: entriesError,
  } = useQuery({
    queryKey: ['timeEntries'],
    queryFn: getTimeEntries,
  });

  // ----------------------------------------
  // Google Sheets configuration
  // ----------------------------------------

  const {
    data: syncConfig = null,
    isPending: isConfigPending,
    error: configError,
  } = useQuery({
    queryKey: ['googleSheetsConfig'],
    queryFn: getSyncConfig,
    retry: false,
    staleTime: Infinity,
  });

  // ----------------------------------------
  // Refresh projects and entries
  // ----------------------------------------

  const refreshData = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ['projects'],
      }),

      queryClient.invalidateQueries({
        queryKey: ['timeEntries'],
      }),
    ]);
  }, [queryClient]);

  // ----------------------------------------
  // Manual synchronization
  // ----------------------------------------

  const syncMutation = useMutation({
    mutationFn: requestSync,

    scope: {
      id: 'project-storage',
    },

    onSuccess: async () => {
      setSyncWarning('');
      await refreshData();
    },
  });

  const { mutate: triggerSync } = syncMutation;

  // ----------------------------------------
  // Synchronize after local changes
  // ----------------------------------------

  const syncAfterLocalChange = useCallback(
    async () => {
      if (!syncConfig) {
        return;
      }

      // Direct Service Worker requests are not tracked by TanStack Query.
      setActiveSyncRequests((count) => count + 1);
      try {
        // Send the current local changes to the worker.
        await requestSync();

        // If another request was already in progress,
        // the worker may have reused that request.
        // Check whether new changes are still pending.
        const state = await chrome.storage.local.get([
          'timeEntries',
          'deletedEntryIds',
          'deletedProjects',
        ]);

        const pendingEntries = (
          state.timeEntries ?? []
        ).some(
          (entry) => entry.syncStatus !== 'synced'
        );

        const pendingDeletions = (
          state.deletedEntryIds ?? []
        ).length > 0;

        const pendingProjects = (await chrome.storage.local.get('projects')).projects?.some(
          (project) => project.syncStatus === 'pending'
        );
        const pendingProjectDeletions = (state.deletedProjects ?? []).length > 0;

        if (pendingEntries || pendingDeletions || pendingProjects || pendingProjectDeletions) {
          await requestSync();
        }

        setSyncWarning('');

        await refreshData();
      } catch (error) {
        console.warn(
          '[Time Tracker] Sync will be retried:',
          error
        );

        setSyncWarning(
          'Изменения сохранены локально. ' +
          'Синхронизация с Google Таблицами ' +
          'будет повторена автоматически.'
        );

        await refreshData();
      } finally {
        setActiveSyncRequests((count) => Math.max(0, count - 1));
      }
    },
    [syncConfig, refreshData]
  );

  // ----------------------------------------
  // Delete a completed session
  // ----------------------------------------

  const deleteSessionMutation = useMutation({
    mutationFn: deleteTimeSession,

    scope: {
      id: 'project-storage',
    },

    onSuccess: async (result) => {
      // Immediately remove the deleted session
      // from the React interface.
      await refreshData();

      if (result.deleted === 0) {
        return;
      }

      // Send queued entry IDs to Google Apps Script.
      // The backend will remove matching rows.
      await syncAfterLocalChange();
    },
  });

  // ----------------------------------------
  // Edit / delete projects
  // ----------------------------------------

  const renameMutation = useMutation({
    mutationFn: renameProject,
    scope: { id: 'project-storage' },
  });

  const deleteProjectMutation = useMutation({
    mutationFn: deleteProject,
    scope: { id: 'project-storage' },
  });

  const handleRenameProject = async (projectId, name) => {
    await renameMutation.mutateAsync({ projectId, name });
    await refreshData();
    await syncAfterLocalChange();
  };

  const handleDeleteProject = async (projectId) => {
    await deleteProjectMutation.mutateAsync(projectId);
    await refreshData();
    await syncAfterLocalChange();
  };

  // ----------------------------------------
  // Handle project creation
  // ----------------------------------------

  const handleProjectCreated = useCallback(
    async () => {
      await refreshData();

      // Register new projects in Google Sheets.
      await syncAfterLocalChange();
    },
    [refreshData, syncAfterLocalChange]
  );

  // ----------------------------------------
  // Handle stopped timer
  // ----------------------------------------

  const handleTimerStopped = useCallback(
    async () => {
      await refreshData();

      // Upload the completed session.
      await syncAfterLocalChange();
    },
    [refreshData, syncAfterLocalChange]
  );

  // ----------------------------------------
  // Timer display updates
  // ----------------------------------------

  const hasRunningTimer = projects.some(
    (project) => project.status === 'running'
  );
  const hasActiveTimer = projects.some(
    (project) => project.status !== 'idle'
  );

  useEffect(() => {
    if (!hasRunningTimer) {
      return undefined;
    }

    const intervalId = setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => {
      clearInterval(intervalId);
    };
  }, [hasRunningTimer]);

  // ----------------------------------------
  // Update React Query when Service Worker
  // changes Chrome Storage.
  // ----------------------------------------

  useEffect(() => {
    const handleStorageChange = (
      changes,
      areaName
    ) => {
      if (areaName !== 'local') {
        return;
      }

      if (changes.projects) {
        void queryClient.invalidateQueries({
          queryKey: ['projects'],
        });
      }

      if (changes.selectedSpreadsheetId) {
        void queryClient.invalidateQueries({ queryKey: ['googleSheetsConfig'] });
      }

      if (changes.timeEntries) {
        void queryClient.invalidateQueries({
          queryKey: ['timeEntries'],
        });
      }
    };

    chrome.storage.onChanged.addListener(
      handleStorageChange
    );

    return () => {
      chrome.storage.onChanged.removeListener(
        handleStorageChange
      );
    };
  }, [queryClient]);

  // ----------------------------------------
  // Initial synchronization
  // ----------------------------------------

  useEffect(() => {
    if (
      !syncConfig ||
      isProjectsPending ||
      isEntriesPending
    ) {
      return;
    }

    triggerSync();
  }, [
    syncConfig,
    isProjectsPending,
    isEntriesPending,
    triggerSync,
  ]);

  // ----------------------------------------
  // Loading
  // ----------------------------------------

  const isLoading =
    isProjectsPending || isEntriesPending;

  // ----------------------------------------
  // Render
  // ----------------------------------------

  return (
    <div className="min-h-screen bg-white text-black">
      <GlobalLoadingIndicator syncing={activeSyncRequests > 0} />
      <main className="mx-auto w-full max-w-[480px] px-5 py-5">
        {/* Header */}

        <header className="mb-7 flex items-center gap-3 border-b border-black/10 pb-5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand text-xl font-black">
            T
          </div>

          <div>
            <h1 className="text-base font-bold">
              Трекер времени
            </h1>

            <p className="mt-1 text-[10px] font-medium uppercase tracking-wide text-slate-500">
              Учёт рабочего времени
            </p>
          </div>
        </header>

        {isConfigPending ? (
          <div role="status" className="py-10 text-center text-xs text-slate-500">
            Проверяем подключение Google Таблицы...
          </div>
        ) : !syncConfig ? (
          <GoogleSheetsPanel
            config={null}
            entries={entries}
            syncMutation={syncMutation}
            onboarding
            hasLocalData={projects.length > 0 || entries.length > 0}
            hasActiveTimer={hasActiveTimer}
          />
        ) : (
          <>
        {/* New project */}

        <section className="mb-7">
            <AddProjectForm onCreated={handleProjectCreated} />
        </section>

        {/* Projects */}

        <section>
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-lg font-bold">
              Мои проекты
            </h2>

            <span className="text-xs text-slate-500">
              Проектов: {projects.length}
            </span>
          </div>

          {isLoading && (
            <p className="py-6 text-center text-xs text-slate-500">
              Загрузка проектов...
            </p>
          )}

          {projectsError && (
            <p
              role="alert"
              className="mb-3 text-xs text-red-600"
            >
              {projectsError.message}
            </p>
          )}

          {entriesError && (
            <p
              role="alert"
              className="mb-3 text-xs text-red-600"
            >
              {entriesError.message}
            </p>
          )}

          {!isLoading && projects.length === 0 && (
            <div className="rounded-xl border border-black/10 px-4 py-8 text-center">
              <p className="text-sm font-semibold">
                Проектов пока нет
              </p>

              <p className="mt-2 text-xs text-slate-500">
                Создайте первый проект,
                чтобы начать учёт времени.
              </p>
            </div>
          )}

          <div className="space-y-3">
            {projects.map((project) => {
              const projectEntries = entries.filter(
                (entry) =>
                  entry.projectId === project.id
              );

              return (
                <ProjectCard
                  key={project.id}
                  project={project}
                  now={now}
                >
                  <TimerControls
                    project={project}
                    onStopped={handleTimerStopped}
                  />

                  <ProjectActions
                    project={project}
                    onRename={handleRenameProject}
                    onDelete={handleDeleteProject}
                    disabled={renameMutation.isPending || deleteProjectMutation.isPending}
                  />

                  
                    {projectEntries.length > 0 && (
                    <SessionHistory
                        entries={projectEntries}
                        onDeleteSession={(sessionId) =>
                        deleteSessionMutation.mutate(sessionId)
                        }
                        isDeleting={deleteSessionMutation.isPending}
                    />
                    )}

                </ProjectCard>
              );
            })}
          </div>

          {/* Deletion errors */}

          {deleteSessionMutation.isError && (
            <p
              role="alert"
              className="mt-3 text-xs text-red-600"
            >
              Не удалось удалить сессию:{' '}
              {deleteSessionMutation.error.message}
            </p>
          )}
        </section>

        {/* Google Sheets */}

        <GoogleSheetsPanel
          config={syncConfig}
          entries={entries}
          syncMutation={syncMutation}
          hasLocalData={projects.length > 0 || entries.length > 0}
          hasActiveTimer={hasActiveTimer}
        />

        {/* Offline / sync warning */}

        {syncWarning && (
          <div
            role="status"
            className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3"
          >
            <p className="text-xs text-amber-800">
              {syncWarning}
            </p>
          </div>
        )}

          </>
        )}

        {configError && (
          <p
            role="alert"
            className="mt-3 text-xs text-red-600"
          >
            {configError.message}
          </p>
        )}

        {/* Footer */}

        <footer className="mt-8 border-t border-black/10 py-5 text-center">
          <p className="text-xs text-slate-500">
            Powered by{' '}
            <span className="font-bold text-black">
              Alex Tukaylo
            </span>
          </p>
        </footer>
      </main>
    </div>
  );
}
