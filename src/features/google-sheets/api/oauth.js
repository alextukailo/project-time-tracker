const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const isDesktop = () => typeof window !== 'undefined' && window.desktop?.platform === 'electron';

export function assertOAuthConfigured() {
  if (isDesktop()) return;
  const clientId = chrome.runtime.getManifest().oauth2?.client_id ?? '';
  if (!clientId.endsWith('.apps.googleusercontent.com') || clientId.startsWith('YOUR_')) {
    throw new Error('Укажите OAuth Client ID в public/manifest.json');
  }
}

export async function getGoogleAccessToken(interactive = false) {
  if (isDesktop()) {
    if (interactive) {
      await window.desktop.auth.signIn();
    } else {
      const state = await window.desktop.auth.status();
      if (!state.authenticated) throw new Error('Требуется вход в Google.');
    }
    // Desktop token never crosses IPC. Sheets requests run in Electron main.
    return 'desktop-authorized';
  }
  assertOAuthConfigured();
  try {
    const response = await chrome.identity.getAuthToken({
      interactive,
      scopes: [SCOPE],
    });
    if (!response?.token) throw new Error('Google не выдал токен доступа');
    return response.token;
  } catch (error) {
    if (!interactive) {
      throw new Error('Требуется вход в Google. Откройте расширение и нажмите «Войти через Google».', { cause: error });
    }
    throw new Error(`Не удалось войти через Google: ${error.message}`, { cause: error });
  }
}

export async function signInWithGoogle() {
  await getGoogleAccessToken(true);
  return true;
}

export async function signOutFromGoogle() {
  if (isDesktop()) return window.desktop.auth.signOut();
  await chrome.identity.clearAllCachedAuthTokens();
}
