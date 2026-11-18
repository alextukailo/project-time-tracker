const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

export function assertOAuthConfigured() {
  const clientId = chrome.runtime.getManifest().oauth2?.client_id ?? '';
  if (!clientId.endsWith('.apps.googleusercontent.com') || clientId.startsWith('YOUR_')) {
    throw new Error('Укажите OAuth Client ID в public/manifest.json');
  }
}

export async function getGoogleAccessToken(interactive = false) {
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
  await chrome.identity.clearAllCachedAuthTokens();
}
