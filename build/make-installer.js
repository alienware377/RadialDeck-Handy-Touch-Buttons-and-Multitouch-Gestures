'use strict';
// Build a single self-contained RadialDeck-Setup.exe:
//   1. zip dist/win-unpacked (the app, already built by pack.js) -> payload.zip
//   2. compile build/setup.cs with csc, embedding payload.zip + uiaccess-setup.ps1 as
//      resources, with a requireAdministrator manifest.
// Run after `node build/pack.js` (or use `npm run installer`).

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const UNPACKED = path.join(ROOT, 'dist', 'win-unpacked');
const OUT = path.join(ROOT, 'dist');
const SEVENZ = path.join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
const CSC = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

if (!fs.existsSync(UNPACKED)) { console.error('dist/win-unpacked not found — run `node build/pack.js` first.'); process.exit(1); }
if (!fs.existsSync(SEVENZ)) { console.error('7za.exe not found at ' + SEVENZ); process.exit(1); }

const zip = path.join(OUT, 'payload.zip');
const exe = path.join(OUT, 'RadialDeck-Setup.exe');
fs.rmSync(zip, { force: true });
fs.rmSync(exe, { force: true });

console.log('Zipping app payload...');
// archive the CONTENTS of win-unpacked (cwd) so files land at the install root on extract
execFileSync(SEVENZ, ['a', '-tzip', '-mx=5', zip, '*'], { cwd: UNPACKED, stdio: 'inherit' });
console.log('payload.zip:', (fs.statSync(zip).size / 1e6).toFixed(1) + 'MB');

console.log('Compiling RadialDeck-Setup.exe...');
execFileSync(CSC, [
  '/nologo', '/target:exe', '/platform:x64',
  '/win32manifest:' + path.join(__dirname, 'setup.manifest'),
  '/reference:System.IO.Compression.dll',
  '/reference:System.IO.Compression.FileSystem.dll',
  '/resource:' + zip + ',payload.zip',
  '/resource:' + path.join(__dirname, 'uiaccess-setup.ps1') + ',uiaccess-setup.ps1',
  '/out:' + exe,
  path.join(__dirname, 'setup.cs'),
], { stdio: 'inherit' });

fs.rmSync(zip, { force: true });
console.log('\nInstaller built:', exe, '(' + (fs.statSync(exe).size / 1e6).toFixed(1) + 'MB)');
