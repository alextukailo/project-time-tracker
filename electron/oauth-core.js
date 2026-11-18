import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const LOGIN_TIMEOUT_MS = 120_000;
const MINIMUM_VALIDITY_MS = 60_000;
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');

function checkClientId(clientId) {
  if (!/^\d+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
    throw new Error('Укажите Client ID типа Desktop app в electron/oauth-config.js');
  }
}

/**
 * Keeps all OAuth credentials in Electron's main process. The renderer receives
 * only boolean auth state, never an access/refresh token or OAuth code.
 */
export function createDesktopOAuth({ clientId, clientSecret, tokenFile, safeStorage, shell, fetchImpl = fetch,
  timeoutMs = LOGIN_TIMEOUT_MS }) {
  const requireClientSecret = () => {
    if (!clientSecret || clientSecret.startsWith('PASTE_') || clientSecret.startsWith('YOUR_')) {
      throw new Error('Укажите Client Secret клиента Desktop app в electron/oauth-client-secret.js');
    }
  };
  let current = null;
  let loaded = false;
  let loginPromise = null;
  let refreshPromise = null;

  function assertSecureStorage() {
    if (!safeStorage.isEncryptionAvailable() ||
        safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
      throw new Error('Защищённое хранилище ОС недоступно. Вход Google отключён во избежание сохранения токена без шифрования.');
    }
  }

  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      const ciphertext = await readFile(tokenFile);
      assertSecureStorage();
      const parsed = JSON.parse(safeStorage.decryptString(ciphertext));
      if (parsed && typeof parsed === 'object') current = parsed;
    } catch (error) {
      if (error.code === 'ENOENT') return;
      loaded = false;
      throw new Error('Не удалось прочитать сохранённую Google-сессию. Проверьте доступ к системному хранилищу.', { cause: error });
    }
  }

  async function save() {
    assertSecureStorage();
    await mkdir(path.dirname(tokenFile), { recursive: true });
    const temporary = `${tokenFile}.tmp`;
    try {
      await writeFile(temporary, safeStorage.encryptString(JSON.stringify(current)), { mode: 0o600 });
      await rename(temporary, tokenFile);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function clear() {
    current = null;
    loaded = true;
    await rm(tokenFile, { force: true });
  }

  async function tokenRequest(params) {
    let response;
    try {
      response = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new Error('Не удалось связаться с Google OAuth. Проверьте интернет.', { cause: error });
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
      const error = new Error(`Google OAuth: ${message}${body.error_description ? ` (${body.error_description})` : ''}`);
      error.oauthCode = body.error;
      throw error;
    }
    if (!body.access_token || !Number.isFinite(Number(body.expires_in))) {
      throw new Error('Google OAuth вернул некорректный ответ.');
    }
    return body;
  }

  function installToken(result, previousRefreshToken) {
    current = {
      accessToken: result.access_token,
      refreshToken: result.refresh_token || previousRefreshToken || null,
      expiry: Date.now() + Number(result.expires_in) * 1000,
    };
  }

  async function refresh() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      await load();
      if (!current?.refreshToken) {
        throw new Error('Требуется вход в Google. Нажмите «Войти через Google».');
      }
      requireClientSecret();
      const oldRefresh = current.refreshToken;
      let response;
      try {
        response = await tokenRequest({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: oldRefresh,
          grant_type: 'refresh_token',
        });
      } catch (error) {
        if (error.oauthCode === 'invalid_grant') {
          await clear();
          throw new Error('Сессия Google отозвана или истекла. Войдите повторно.', { cause: error });
        }
        throw error;
      }
      installToken(response, oldRefresh);
      await save();
      return current.accessToken;
    })().finally(() => { refreshPromise = null; });
    return refreshPromise;
  }

  async function getAccessToken({ forceRefresh = false } = {}) {
    checkClientId(clientId);
    await load();
    if (!current) {
      throw new Error('Требуется вход в Google. Нажмите «Войти через Google».');
    }
    if (!forceRefresh && current.accessToken && current.expiry > Date.now() + MINIMUM_VALIDITY_MS) {
      return current.accessToken;
    }
    return refresh();
  }

  async function status() {
    checkClientId(clientId);
    await load();
    return { authenticated: Boolean(current?.refreshToken || (current?.accessToken && current.expiry > Date.now())) };
  }

  async function login() {
    checkClientId(clientId);
    requireClientSecret();
    assertSecureStorage();
    if (loginPromise) return loginPromise;
    loginPromise = (async () => {
      const state = b64url(randomBytes(32));
      const verifier = b64url(randomBytes(48));
      const challenge = b64url(createHash('sha256').update(verifier).digest());
      const redirectPath = '/';
      let completed = false;
      let server;
      let timeout;
      let rejectCode;
      const codePromise = new Promise((resolve, reject) => {
        rejectCode = reject;
        server = createServer((req, res) => {
          const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
          if (req.method !== 'GET' || requestUrl.pathname !== redirectPath) {
            res.writeHead(404); res.end(); return;
          }
          if (requestUrl.searchParams.get('state') !== state) {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Неверное состояние OAuth. Вернитесь в приложение и повторите вход.');
            return;
          }
          if (completed) {
            res.writeHead(409); res.end(); return;
          }
          completed = true;
          const errorCode = requestUrl.searchParams.get('error');
          const code = requestUrl.searchParams.get('code');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
            'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
          res.end('<!doctype html><html lang="ru"><meta charset="utf-8"><title>Time Tracker</title>' +
            '<body style="font:16px system-ui;padding:3em">Авторизация завершена. Вернитесь в Time Tracker. Эту вкладку можно закрыть.</body></html>');
          if (errorCode) reject(new Error(`Вход Google отклонён: ${errorCode}`));
          else if (code) resolve(code);
          else reject(new Error('Google не вернул код авторизации.'));
        });
      });
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', resolve);
        });
        const redirectUri = `http://127.0.0.1:${server.address().port}${redirectPath}`;
        const authorizeUrl = new URL(AUTH_URL);
        for (const [key, value] of Object.entries({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: GOOGLE_SCOPE,
          access_type: 'offline',
          prompt: 'consent select_account',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state,
        })) authorizeUrl.searchParams.set(key, value);
        timeout = setTimeout(() => rejectCode(new Error('Время ожидания входа Google истекло. Повторите попытку.')), timeoutMs);
        await shell.openExternal(authorizeUrl.toString());
        const code = await codePromise;
        const tokens = await tokenRequest({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        });
        await load();
        installToken(tokens, null);
        if (!current.refreshToken) {
          throw new Error('Google не выдал refresh token. Отзовите доступ в настройках аккаунта Google и повторите вход.');
        }
        await save();
        return { authenticated: true };
      } finally {
        clearTimeout(timeout);
        server?.close();
      }
    })().finally(() => { loginPromise = null; });
    return loginPromise;
  }

  async function logout() {
    await load();
    const token = current?.refreshToken || current?.accessToken;
    await clear();
    if (token) {
      // Best effort; local credentials are deleted even when offline.
      await fetchImpl(REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => {});
    }
    return { authenticated: false };
  }

  return { status, login, logout, getAccessToken };
}
