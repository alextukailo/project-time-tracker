import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modules = [
  'electron/main.js',
  'electron/preload.js',
  'electron/storage.js',
  'electron/oauth-core.js',
  'electron/oauth-config.js',
  'electron/oauth-client-secret.js',
  'electron/sheets-service.js',
];
let hasError = false;
for (const relative of modules) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) {
    console.error(`MISSING: ${relative}`);
    hasError = true;
    continue;
  }
  try {
    execFileSync(process.execPath, ['--check', absolute], { stdio: 'pipe' });
    console.log(`OK: ${relative}`);
  } catch {
    console.error(`SYNTAX ERROR: ${relative}`);
    hasError = true;
  }
}
for (const relative of modules) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) continue;
  const code = fs.readFileSync(absolute, 'utf8');
  const importPattern = /(?:import\s+(?:[^'";]*?\s+from\s+)?|export\s+[^'";]*?\s+from\s+)['"](\.{1,2}\/[^'"]+)['"]/g;
  for (const match of code.matchAll(importPattern)) {
    const imported = path.resolve(path.dirname(absolute), match[1]);
    if (![imported, imported + '.js', imported + '.mjs', imported + '.jsx'].some(p => fs.existsSync(p))) {
      console.error(`BROKEN IMPORT: ${relative} -> ${match[1]}`);
      hasError = true;
    }
  }
}
if (hasError) {
  console.error('\nSome Electron files are missing or invalid. Do not run desktop:build yet.');
  process.exitCode = 1;
} else {
  console.log('\nElectron source files and local imports are present. Proceed to desktop:build.');
}
