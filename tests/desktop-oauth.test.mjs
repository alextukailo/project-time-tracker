import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDesktopOAuth } from '../electron/oauth-core.js';

const clientId = '123456789-testDesktopClient.apps.googleusercontent.com';
const clientSecret = 'GOCSP-test-secret';
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'keychain',
  encryptString: (data) => Buffer.from(`protected:${data}`),
  decryptString: (cipher) => {
    const value = cipher.toString();
    if (!value.startsWith('protected:')) throw new Error('wrong ciphertext');
    return value.slice('protected:'.length);
  },
};

test('desktop PKCE login: browser loopback, state guard, encrypted persisted refresh token, reuse', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tracker-oauth-test-'));
  const tokenFile = path.join(dir, 'auth.enc');
  const requests = [];
  let authURL;
  let createdTokens = 0;
  const fetchImpl = async (url, opts) => {
    requests.push({ url: String(url), params: Object.fromEntries(new URLSearchParams(opts.body)) });
    if (url.includes('/revoke')) return { ok: true, status: 200, json: async () => ({}) };
    const body = Object.fromEntries(new URLSearchParams(opts.body));
    if (body.grant_type === 'authorization_code') {
      createdTokens++;
      assert.equal(body.redirect_uri, authURL.searchParams.get('redirect_uri'));
      assert.equal(body.client_id, clientId);
      assert.equal(body.client_secret, clientSecret);
      assert.equal(body.code, 'test-code');
      const challenge = createHash('sha256').update(body.code_verifier).digest('base64url');
      assert.equal(challenge, authURL.searchParams.get('code_challenge'));
      return { ok: true, status: 200, json: async () => ({ access_token: 'first-access', refresh_token: 'refresh-secret', expires_in: 30 }) };
    }
    if (body.grant_type === 'refresh_token') {
      assert.equal(body.refresh_token, 'refresh-secret');
      assert.equal(body.client_secret, clientSecret);
      return { ok: true, status: 200, json: async () => ({ access_token: 'renewed-access', expires_in: 3600 }) };
    }
    throw new Error('unexpected endpoint');
  };
  const shell = {
    openExternal: async (url) => {
      authURL = new URL(url);
      assert.equal(authURL.origin, 'https://accounts.google.com');
      assert.equal(authURL.searchParams.get('scope'), 'https://www.googleapis.com/auth/spreadsheets');
      assert.equal(authURL.searchParams.get('access_type'), 'offline');
      assert.equal(authURL.searchParams.get('code_challenge_method'), 'S256');
      const redirect = new URL(authURL.searchParams.get('redirect_uri'));
      assert.equal(redirect.hostname, '127.0.0.1');
      const wrong = new URL(redirect);
      wrong.searchParams.set('state', 'incorrect-state');
      wrong.searchParams.set('code', 'attacker-code');
      const wrongResponse = await fetch(wrong);
      assert.equal(wrongResponse.status, 400);
      const correct = new URL(redirect);
      correct.searchParams.set('state', authURL.searchParams.get('state'));
      correct.searchParams.set('code', 'test-code');
      const ok = await fetch(correct);
      assert.equal(ok.status, 200);
    },
  };
  try {
    const oauth = createDesktopOAuth({ clientId, clientSecret, tokenFile, safeStorage: fakeSafeStorage, shell, fetchImpl });
    assert.deepEqual(await oauth.status(), { authenticated: false });
    assert.deepEqual(await oauth.login(), { authenticated: true });
    assert.equal(createdTokens, 1);
    assert.deepEqual(await oauth.status(), { authenticated: true });
    const bytes = await readFile(tokenFile, 'utf8');
    assert.doesNotMatch(bytes, /^\s*\{/);
    assert.equal(await oauth.getAccessToken(), 'renewed-access'); // short first token triggers refresh
    const oauthAgain = createDesktopOAuth({ clientId, clientSecret, tokenFile, safeStorage: fakeSafeStorage, shell, fetchImpl });
    assert.equal(await oauthAgain.getAccessToken(), 'renewed-access');
    assert.deepEqual(await oauthAgain.logout(), { authenticated: false });
    assert.deepEqual(await oauthAgain.status(), { authenticated: false });
    assert.ok(requests.some((item) => item.url.includes('/revoke')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('desktop OAuth rejects invalid client ID and insecure token storage', async () => {
  const oauth = createDesktopOAuth({
    clientId: 'YOUR_DESKTOP_CLIENT_ID.apps.googleusercontent.com',
    clientSecret,
    tokenFile: '/tmp/should-not-be-used',
    safeStorage: fakeSafeStorage,
    shell: { openExternal: async () => {} },
  });
  await assert.rejects(oauth.login(), /Client ID типа Desktop app/);
  const noEncryption = createDesktopOAuth({
    clientId,
    clientSecret,
    tokenFile: '/tmp/should-not-be-used',
    safeStorage: { isEncryptionAvailable: () => false },
    shell: { openExternal: async () => {} },
  });
  await assert.rejects(noEncryption.login(), /Защищённое хранилище/);
});


test('desktop OAuth refuses login when Desktop client secret is missing', async () => {
  const oauth = createDesktopOAuth({
    clientId,
    clientSecret: 'PASTE_DESKTOP_CLIENT_SECRET_HERE',
    tokenFile: '/tmp/should-not-be-used',
    safeStorage: fakeSafeStorage,
    shell: { openExternal: async () => { throw new Error('Browser should not open'); } },
  });
  await assert.rejects(oauth.login(), /Client Secret клиента Desktop app/);
});
