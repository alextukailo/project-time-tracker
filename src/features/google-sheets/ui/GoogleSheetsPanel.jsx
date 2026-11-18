import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Spinner } from '@/shared/ui/Spinner';
import {
  signInWithGoogle,
  connectSpreadsheet,
  disconnectSpreadsheet,
} from '../api/googleSheetsApi';
import { getGoogleAccessToken } from '../api/oauth';

export function GoogleSheetsPanel({
  config,
  entries = [],
  syncMutation,
  onboarding = false,
  hasLocalData = false,
  hasActiveTimer = false,
}) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState('');
  const [signedIn, setSignedIn] = useState(false);
  const [checkingLogin, setCheckingLogin] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const [importLocal, setImportLocal] = useState(false);

  // A popup is recreated every time it opens. Check the cached Google session
  // silently, without triggering an authorization popup on startup.
  useEffect(() => {
    if (config && !showConnect) return undefined;
    let active = true;
    getGoogleAccessToken(false)
      .then(() => { if (active) setSignedIn(true); })
      .catch(() => { if (active) setSignedIn(false); })
      .finally(() => { if (active) setCheckingLogin(false); });
    return () => { active = false; };
  }, [config, showConnect]);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['googleSheetsConfig'] }),
      queryClient.invalidateQueries({ queryKey: ['projects'] }),
      queryClient.invalidateQueries({ queryKey: ['timeEntries'] }),
    ]);
  };

  const signIn = useMutation({
    mutationFn: signInWithGoogle,
    onSuccess: () => setSignedIn(true),
  });

  const connect = useMutation({
    mutationFn: () => connectSpreadsheet(url.trim(), { importLocal }),
    onSuccess: async () => {
      setShowConnect(false);
      setShowSettings(false);
      setUrl('');
      setImportLocal(false);
      await refresh();
      syncMutation.mutate();
    },
  });

  const disconnect = useMutation({
    mutationFn: disconnectSpreadsheet,
    onSuccess: async () => {
      setShowSettings(false);
      setShowConnect(false);
      setSignedIn(false);
      setCheckingLogin(true);
      await refresh();
    },
  });

  const isBusy = signIn.isPending || connect.isPending || disconnect.isPending || syncMutation.isPending;
  const error = signIn.error || connect.error || disconnect.error || syncMutation.error;
  const pendingCount = entries.filter((entry) => entry.syncStatus !== 'synced').length;
  const needsSetup = !config || showConnect;

  if (needsSetup) {
    return (
      <section className={onboarding ? 'space-y-5' : 'mt-6 space-y-5 border-t border-black/10 pt-5'}>
        <div>
          <h2 className="text-lg font-bold">
            {onboarding ? 'Подключите Google Таблицу' : 'Выбрать другую таблицу'}
          </h2>
          <p className="mt-2 text-xs leading-5 text-gray-600">
            Войдите в Google и укажите ссылку на таблицу с правом редактирования.
            Мы автоматически настроим синхронизацию времени.
          </p>
        </div>

        <div className="rounded-xl border border-black/10 p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand text-xs">1</span>
            Войти в Google
          </div>
          {checkingLogin ? (
            <div role="status" className="flex items-center gap-2 text-xs text-gray-500">
              <Spinner /> Проверяем авторизацию...
            </div>
          ) : signedIn ? (
            <div className="flex items-center gap-2 text-xs font-medium text-green-700">
              <span aria-hidden="true">✓</span> Google подключён
            </div>
          ) : (
            <button
              type="button"
              disabled={isBusy}
              aria-busy={signIn.isPending}
              onClick={() => signIn.mutate()}
              className="w-full rounded-lg border border-black/20 px-4 py-3 text-xs font-semibold disabled:opacity-50"
            >
              <span className="inline-flex items-center justify-center gap-2">
                {signIn.isPending && <Spinner />}
                {signIn.isPending ? 'Открываем Google...' : 'Войти через Google'}
              </span>
            </button>
          )}
        </div>

        <form onSubmit={(event) => { event.preventDefault(); connect.mutate(); }}
          className="space-y-3 rounded-xl border border-black/10 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand text-xs">2</span>
            Подключить таблицу
          </div>
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="spreadsheet-url" className="text-xs font-semibold">
              Ссылка на Google Таблицу
            </label>
            <a href="https://docs.google.com/spreadsheets/create"
              target="_blank" rel="noreferrer"
              className="shrink-0 text-[11px] text-gray-600 underline">
              Создать таблицу
            </a>
          </div>
          <input
            id="spreadsheet-url"
            type="url"
            required
            autoComplete="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            disabled={!signedIn || checkingLogin || isBusy}
            placeholder="https://docs.google.com/spreadsheets/d/..."
            className="w-full rounded-lg border border-black/15 px-3 py-3 text-xs outline-none focus:border-brand disabled:bg-gray-50 disabled:text-gray-400"
          />
          {hasLocalData && (
            <label className="flex items-start gap-2 text-xs text-gray-700">
              <input type="checkbox" checked={importLocal}
                disabled={isBusy}
                onChange={(event) => setImportLocal(event.target.checked)} className="mt-0.5" />
              Перенести существующие локальные проекты и историю в эту таблицу
            </label>
          )}
          <button
            type="submit"
            disabled={!signedIn || !url.trim() || isBusy}
            aria-busy={connect.isPending}
            className="w-full rounded-lg bg-brand px-4 py-3 text-xs font-semibold disabled:opacity-50"
          >
            <span className="inline-flex items-center justify-center gap-2">
              {connect.isPending && <Spinner />}
              {connect.isPending ? 'Подключаем...' : 'Подключить и начать работу'}
            </span>
          </button>
          {config && (
            <button type="button" disabled={isBusy}
              onClick={() => setShowConnect(false)}
              className="w-full py-2 text-xs text-gray-600">
              Отмена
            </button>
          )}
        </form>
        {error && <p role="alert" className="text-xs text-red-600">{error.message}</p>}
        {onboarding && (
          <p className="text-center text-[11px] leading-4 text-gray-500">
            Данные синхронизируются с выбранной Google Таблицей через ваш аккаунт.
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="mt-7 border-t border-black/10 pt-5">
      <h2 className="mb-3 text-sm font-bold">Google Таблицы</h2>
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-xs">
          <span className="h-2 w-2 rounded-full bg-green-600" />
          <span>Таблица подключена</span>
        </div>
        <a className="block break-words text-xs font-semibold underline"
          href={config.spreadsheetUrl} target="_blank" rel="noreferrer">
          {config.spreadsheetTitle}
        </a>
        {pendingCount > 0 && <p className="text-xs text-gray-500">Ожидают отправки: {pendingCount}</p>}
        <button type="button" disabled={isBusy} aria-busy={syncMutation.isPending}
          onClick={() => syncMutation.mutate()}
          className="w-full rounded-lg bg-brand px-4 py-3 text-xs font-semibold disabled:opacity-50">
          <span className="inline-flex items-center justify-center gap-2">
            {syncMutation.isPending && <Spinner />}
            {syncMutation.isPending ? 'Синхронизация...' : 'Синхронизировать'}
          </span>
        </button>
        {syncMutation.isSuccess && (
          <p className="text-xs text-green-700">Записей в таблице: {syncMutation.data?.received ?? 0}</p>
        )}
        <button type="button" className="w-full py-2 text-xs text-gray-600 underline"
          disabled={isBusy} onClick={() => setShowSettings((current) => !current)}>
          {showSettings ? 'Скрыть настройки' : 'Настройки подключения'}
        </button>
        {showSettings && (
          <div className="space-y-2 rounded-lg border border-black/10 p-3">
            <button type="button" disabled={isBusy || hasActiveTimer}
              onClick={() => setShowConnect(true)}
              className="w-full rounded-lg border border-black/15 py-2 text-xs">
              Выбрать другую таблицу
            </button>
            <button type="button" disabled={isBusy} aria-busy={signIn.isPending}
              onClick={() => signIn.mutate()}
              className="w-full rounded-lg border border-black/15 py-2 text-xs">
              Повторить вход в Google
            </button>
            <button type="button" disabled={isBusy || hasActiveTimer}
              aria-busy={disconnect.isPending}
              onClick={() => disconnect.mutate()}
              className="w-full py-2 text-xs text-gray-500 underline">
              Отключить таблицу
            </button>
            {hasActiveTimer && (
              <p className="text-[11px] text-gray-500">Остановите таймер перед сменой таблицы.</p>
            )}
          </div>
        )}
        {error && <p role="alert" className="text-xs text-red-600">{error.message}</p>}
      </div>
    </section>
  );
}
