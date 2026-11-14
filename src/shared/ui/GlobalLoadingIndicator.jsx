import { useEffect, useState } from 'react';
import { useIsFetching, useIsMutating } from '@tanstack/react-query';
import { Spinner } from './Spinner';

// Detects every TanStack Query request and mutation in the popup.
// `syncing` covers direct Service Worker requests made outside useMutation.
export function GlobalLoadingIndicator({ syncing = false }) {
  const fetchingCount = useIsFetching();
  const mutatingCount = useIsMutating();
  const busy = fetchingCount > 0 || mutatingCount > 0 || syncing;
  const [visible, setVisible] = useState(false);

  // Avoid flickering for fast local Chrome Storage operations.
  useEffect(() => {
    const timeoutId = setTimeout(
      () => setVisible(busy),
      busy ? 180 : 0
    );

    return () => clearTimeout(timeoutId);
  }, [busy]);

  if (!visible) return null;

  const label = syncing
    ? 'Синхронизация...'
    : mutatingCount > 0
      ? 'Сохранение изменений...'
      : 'Загрузка данных...';

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="pointer-events-none fixed right-3 top-3 z-50 flex max-w-[calc(100%-24px)] items-center gap-2 rounded-lg bg-black px-3 py-2 text-xs font-medium text-white shadow-lg"
    >
      <Spinner className="text-brand" />
      <span>{label}</span>
    </div>
  );
}
