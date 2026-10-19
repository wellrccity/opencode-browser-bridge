/*
 * Lightweight repository check: syntax, manifest references and icon files.
 * Runs without Chrome or a running MCP server.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const skipDirs = new Set(['node_modules', '.git', 'dist', 'build']);
const failures = [];
const notes = [];

function walk(directory) {
  const out = [];
  for (const entry of readdirSync(directory)) {
    if (skipDirs.has(entry)) continue;
    const full = join(directory, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = walk(root);
const jsFiles = files.filter((file) => ['.js', '.mjs', '.cjs'].includes(extname(file)));

for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failures.push(`syntax: ${relative(root, file)}\n${(result.stderr || result.stdout || '').trim()}`);
  }
}
notes.push(`checked ${jsFiles.length} JavaScript file(s)`);

const manifestPath = join(root, 'extension', 'manifest.json');
if (!existsSync(manifestPath)) {
  failures.push('missing extension/manifest.json');
} else {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    failures.push(`extension/manifest.json is not valid JSON: ${error.message}`);
  }
  if (manifest) {
    const references = [];
    if (manifest.background && manifest.background.service_worker) references.push(manifest.background.service_worker);
    if (manifest.action && manifest.action.default_popup) references.push(manifest.action.default_popup);
    if (manifest.action && manifest.action.default_icon) references.push(...Object.values(manifest.action.default_icon));
    if (manifest.icons) references.push(...Object.values(manifest.icons));
    for (const script of manifest.content_scripts || []) {
      references.push(...(script.js || []));
      references.push(...(script.css || []));
    }
    for (const reference of new Set(references)) {
      const target = join(root, 'extension', reference);
      if (!existsSync(target)) failures.push(`manifest references missing file: extension/${reference}`);
    }
    notes.push(`manifest: ${manifest.name || '(sem nome)'} v${manifest.version || '?'}`);
  }
}

for (const size of [16, 48, 128]) {
  const icon = join(root, 'extension', 'icons', `icon${size}.png`);
  if (!existsSync(icon)) {
    failures.push(`missing icon: extension/icons/icon${size}.png`);
    continue;
  }
  const data = readFileSync(icon);
  const signature = data.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') failures.push(`invalid PNG signature: extension/icons/icon${size}.png`);
  if (data.length < 100) failures.push(`suspiciously small icon: extension/icons/icon${size}.png`);
}

const configPath = join(root, 'opencode.jsonc');
if (!existsSync(configPath)) {
  failures.push('missing opencode.jsonc');
} else {
  const text = readFileSync(configPath, 'utf8');
  if (!/"chrome"\s*:/.test(text)) failures.push('opencode.jsonc does not define the "chrome" MCP server');
  if (!/server\/src\/index\.js/.test(text)) failures.push('opencode.jsonc does not point to server/src/index.js');
  notes.push('opencode.jsonc: chrome MCP entry found');
}

const popup = join(root, 'extension', 'popup.html');
if (existsSync(popup)) {
  const text = readFileSync(popup, 'utf8');
  for (const id of ['statusPill', 'connectionForm', 'serverUrl', 'token', 'connectBtn', 'detachBtn']) {
    if (!text.includes(`id="${id}"`)) failures.push(`popup.html is missing #${id}`);
  }
  notes.push('popup: expected controls found');
}

for (const note of notes) console.log(`ok  ${note}`);
if (failures.length) {
  console.error('');
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`\n${failures.length} problem(s) found.`);
  process.exitCode = 1;
} else {
  console.log('\nAll checks passed.');
}
