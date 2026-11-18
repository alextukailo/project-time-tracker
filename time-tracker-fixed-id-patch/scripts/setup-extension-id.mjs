#!/usr/bin/env node
// Generates and pins a stable unpacked Chrome extension ID.
// Uses Node.js built-in crypto; no dependency or network access required.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  chmodSync,
} from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const manifestPath = path.join(root, 'public', 'manifest.json');
const distManifestPath = path.join(root, 'dist', 'manifest.json');
const privateDir = path.join(root, '.secrets');
const privatePath = path.join(privateDir, 'time-tracker-extension.pem');
const gitignorePath = path.join(root, '.gitignore');
const checkOnly = process.argv.includes('--check');

function fail(message) {
  console.error(`\nERROR: ${message}`);
  process.exit(1);
}

function extensionId(derPublicKey) {
  const hash = createHash('sha256').update(derPublicKey).digest();
  return [...hash.subarray(0, 16)]
    .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)))
    .join('');
}

function publicKeyDerFromPrivate(pem) {
  return createPublicKey(createPrivateKey(pem)).export({ type: 'spki', format: 'der' });
}

if (!existsSync(manifestPath)) fail(`File not found: ${manifestPath}. Run from project root.`);
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (error) {
  fail(`Invalid JSON in public/manifest.json: ${error.message}`);
}

if (manifest.manifest_version !== 3) fail('Expected a Manifest V3 extension.');

if (checkOnly) {
  if (!manifest.key) fail('No manifest.key. Run: node scripts/setup-extension-id.mjs');
  const publicDer = Buffer.from(manifest.key, 'base64');
  if (!publicDer.length || publicDer.toString('base64') !== manifest.key) {
    fail('manifest.key is not valid base64.');
  }
  const id = extensionId(publicDer);
  console.log(`Extension ID: ${id}`);
  if (existsSync(distManifestPath)) {
    const built = JSON.parse(readFileSync(distManifestPath, 'utf8'));
    if (built.key !== manifest.key) fail('dist/manifest.json has a different key. Run npm run build.');
    console.log('dist/manifest.json: matching key');
  } else {
    console.log('dist/manifest.json: not built yet');
  }
  if (!manifest.oauth2?.client_id || manifest.oauth2.client_id.startsWith('YOUR_')) {
    console.log('OAuth Client ID: still needs to be configured in public/manifest.json.');
  } else {
    console.log('OAuth Client ID: present (verify its Item ID matches Extension ID above).');
  }
  process.exit(0);
}

let publicDer;
let generated = false;

if (existsSync(privatePath)) {
  publicDer = publicKeyDerFromPrivate(readFileSync(privatePath, 'utf8'));
  console.log('Reusing existing private key in .secrets/');
} else if (manifest.key) {
  publicDer = Buffer.from(manifest.key, 'base64');
  if (!publicDer.length || publicDer.toString('base64') !== manifest.key) {
    fail('Existing manifest.key is invalid. Not changing anything.');
  }
  console.log('Existing manifest.key found. Keeping this Extension ID.');
} else {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  publicDer = pair.publicKey;
  mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  writeFileSync(privatePath, pair.privateKey, { mode: 0o600, flag: 'wx' });
  chmodSync(privatePath, 0o600);
  generated = true;
  console.log('Created .secrets/time-tracker-extension.pem locally. KEEP IT PRIVATE.');
}

const keyValue = publicDer.toString('base64');
if (manifest.key && manifest.key !== keyValue) {
  fail('Private key in .secrets/ does not match manifest.key. No changes were made.');
}

if (!manifest.key) {
  manifest.key = keyValue;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log('Updated public/manifest.json with the PUBLIC key.');
}

const ignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
if (!ignore.split(/\r?\n/).some((line) => line.trim() === '.secrets/' || line.trim() === '/.secrets/')) {
  appendFileSync(gitignorePath, `${ignore.endsWith('\n') || !ignore ? '' : '\n'}.secrets/\n`);
  console.log('Added .secrets/ to .gitignore.');
}

const id = extensionId(publicDer);
console.log(`\nSTABLE EXTENSION ID: ${id}`);
console.log('Next: create a Chrome Extension OAuth client for this exact Item ID in Google Cloud.');
console.log('Copy its Client ID into public/manifest.json -> oauth2.client_id.');
console.log('Then run: npm run build && node scripts/setup-extension-id.mjs --check');
if (generated) {
  console.log('\nWARNING: Your existing Chrome installation has a different ID. Back up existing local data before switching.');
}
