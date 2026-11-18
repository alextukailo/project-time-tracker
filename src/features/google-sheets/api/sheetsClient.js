import axios from 'axios';
import { getGoogleAccessToken } from './oauth';

const ROOT = 'https://sheets.googleapis.com/v4/spreadsheets';
const KEY_PATTERN = /^[A-Za-z0-9_-]{20,}$/;

export function extractSpreadsheetId(url) {
  try {
    const parsed = new URL(String(url).trim());
    const match = parsed.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]+)(?:\/|$)/);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'docs.google.com' || !match || !KEY_PATTERN.test(match[1])) {
      throw new Error();
    }
    return match[1];
  } catch {
    throw new Error('Вставьте ссылку вида https://docs.google.com/spreadsheets/d/ID/edit');
  }
}

export function spreadsheetUrl(id) {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/edit`;
}

export async function sheetsRequest(id, method = 'get', suffix = '', data, params) {
  const run = async (token) => axios({
    method,
    url: `${ROOT}/${encodeURIComponent(id)}${suffix}`,
    data,
    params,
    timeout: 30000,
    headers: { Authorization: `Bearer ${token}` },
  });

  try {
    let token = await getGoogleAccessToken(false);
    try {
      return (await run(token)).data;
    } catch (error) {
      if (error.response?.status !== 401) throw error;
      await chrome.identity.removeCachedAuthToken({ token });
      token = await getGoogleAccessToken(false);
      return (await run(token)).data;
    }
  } catch (error) {
    if (error.response?.status === 403) {
      throw new Error('Нет прав на редактирование этой таблицы или Google Sheets API не включён в Google Cloud.', { cause: error });
    }
    if (error.response?.status === 404) {
      throw new Error('Таблица не найдена. Проверьте ссылку и Google-аккаунт.', { cause: error });
    }
    throw error;
  }
}

export async function loadSpreadsheet(id) {
  return sheetsRequest(id, 'get', '', undefined, {
    includeGridData: true,
    fields: 'spreadsheetId,properties(title,timeZone,locale),sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)),data(startRow,rowData(values(formattedValue,effectiveValue,userEnteredValue)))),developerMetadata',
  });
}

export async function applyRequests(id, requests) {
  if (!requests.length) return;
  // Google Sheets batches are validated and applied atomically.
  for (let index = 0; index < requests.length; index += 400) {
    await sheetsRequest(id, 'post', ':batchUpdate', {
      requests: requests.slice(index, index + 400),
    });
  }
}

export async function verifySpreadsheetAccess(id) {
  const data = await sheetsRequest(id, 'get', '', undefined, {
    fields: 'spreadsheetId,properties(title),sheets(properties(sheetId,title))',
  });
  return { id: data.spreadsheetId, title: data.properties?.title || 'Google Таблица' };
}
