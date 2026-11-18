const API_ROOT = 'https://sheets.googleapis.com/v4/spreadsheets/';
const ID_PATTERN = /^[a-zA-Z0-9_-]{20,}$/;

function validateRequest(payload) {
  if (!payload || typeof payload !== 'object' || !ID_PATTERN.test(payload.id ?? '')) {
    throw new Error('Некорректный ID Google Таблицы.');
  }
  const { id, method = 'get', suffix = '', data, params } = payload;
  if ((method !== 'get' || suffix !== '') &&
      (method !== 'post' || suffix !== ':batchUpdate')) {
    throw new Error('Неподдерживаемая операция с Google Таблицей.');
  }
  if (method === 'post' && (!data || !Array.isArray(data.requests) || data.requests.length > 400)) {
    throw new Error('Некорректный пакет изменений Google Sheets.');
  }
  if (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params))) {
    throw new Error('Некорректные параметры запроса Google Sheets.');
  }
  return { id, method, suffix, data, params };
}

export function createSheetsService({ auth, fetchImpl = fetch }) {
  async function request(payload) {
    const { id, method, suffix, data, params } = validateRequest(payload);
    const url = new URL(`${API_ROOT}${encodeURIComponent(id)}${suffix}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        url.searchParams.set(key, String(value));
      }
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await auth.getAccessToken({ forceRefresh: attempt > 0 });
      let response;
      try {
        response = await fetchImpl(url, {
          method: method.toUpperCase(),
          headers: {
            Authorization: `Bearer ${token}`,
            ...(data ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(data ? { body: JSON.stringify(data) } : {}),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        throw new Error('Нет соединения с Google Sheets API.', { cause: error });
      }
      if (response.status === 401 && attempt === 0) continue;
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(body?.error?.message || `Ошибка Google Sheets API (HTTP ${response.status}).`);
        error.status = response.status;
        throw error;
      }
      return body;
    }
    throw new Error('Google отклонил токен авторизации. Войдите повторно.');
  }

  return { request };
}
