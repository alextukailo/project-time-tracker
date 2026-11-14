import { Spinner } from '@/shared/ui/Spinner';


export function GoogleSheetsPanel({
  config,
  entries = [],
  syncMutation,
}) {
  const pendingCount = entries.filter(
    (entry) => entry.syncStatus !== 'synced'
  ).length;

  return (
    <section className="mt-7 border-t border-black/10 pt-5">
      <h2 className="mb-4 text-sm font-bold">
        Google Таблицы
      </h2>

      <div className="space-y-3">
        <div className="flex items-center gap-2 text-xs">
          <span
            className={`h-2 w-2 rounded-full ${
              config ? 'bg-green-600' : 'bg-red-500'
            }`}
          />

          <span>
            {config
              ? 'Подключение настроено'
              : 'Подключение не настроено'}
          </span>
        </div>

        <div className="flex justify-between text-xs">
          <span className="text-gray-500">
            Ожидают синхронизации
          </span>

          <span className="font-semibold">
            {pendingCount}
          </span>
        </div>

        <button
          type="button"
          disabled={!config || syncMutation.isPending}
          aria-busy={syncMutation.isPending}
          onClick={() => syncMutation.mutate()}
          className="w-full rounded-lg bg-brand px-4 py-3 text-xs font-semibold disabled:opacity-50"
        >
          <span className="inline-flex items-center justify-center gap-2">
            {syncMutation.isPending && <Spinner />}
            {syncMutation.isPending ? 'Синхронизация...' : 'Синхронизировать'}
          </span>
        </button>

        {syncMutation.isSuccess &&
          !syncMutation.isPending && (
            <p className="text-xs text-green-700">
              Синхронизировано записей:{' '}
              {syncMutation.data.received}
            </p>
          )}

        {syncMutation.isError && (
          <p
            role="alert"
            className="text-xs text-red-600"
          >
            {syncMutation.error.message}
          </p>
        )}
      </div>
    </section>
  );
}
