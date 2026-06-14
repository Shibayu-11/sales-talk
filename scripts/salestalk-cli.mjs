#!/usr/bin/env node
/**
 * salestalk CLI launcher.
 * Spawns the Electron binary (packaged) or uses electron (dev) in --cli mode.
 *
 * Usage (after `npm install`):
 *   npx salestalk record start --product real_estate
 *   npx salestalk transcribe --file /path/to/meeting.m4a
 *
 * Dev usage (against out/ after `electron-vite build`):
 *   npm run cli -- record start --product real_estate
 *   npm run cli -- transcribe --file ./sample.m4a
 *
 * In a packaged app the `salestalk` binary in the DMG's MacOS dir invokes
 * the Electron app with --cli; this shim is for dev and npm-run usage only.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

// Find the electron binary
const require_ = createRequire(import.meta.url);
let electronBin;
try {
  // electron package exports its binary path via require('electron')
  electronBin = require_(join(projectRoot, 'node_modules', 'electron'));
} catch {
  console.error('Could not locate electron binary. Run `npm install` first.');
  process.exit(1);
}

// Determine entry point: prefer built out/main/index.js, fall back to src entry for dev
const builtEntry = join(projectRoot, 'out', 'main', 'index.js');
const devEntry = join(projectRoot, 'src', 'main', 'index.ts');

let entry;
if (existsSync(builtEntry)) {
  entry = builtEntry;
} else if (existsSync(devEntry)) {
  // Dev mode without a build: require electron-vite to be running, or error.
  console.error(
    'Built output not found at out/main/index.js.\n' +
    'Run `npm run build` first, then retry.\n' +
    '(Dev note: electron-vite build transpiles to out/ — raw .ts cannot be run directly by Electron.)',
  );
  process.exit(1);
} else {
  console.error(`Neither ${builtEntry} nor ${devEntry} found. Build the project first.`);
  process.exit(1);
}

// Forward all user args after the script name, plus the --cli marker
const userArgs = process.argv.slice(2);
const child = spawn(String(electronBin), [entry, '--cli', ...userArgs], {
  stdio: 'inherit',
  env: { ...process.env },
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});

child.on('error', (err) => {
  console.error('Failed to spawn Electron:', err.message);
  process.exit(1);
});
