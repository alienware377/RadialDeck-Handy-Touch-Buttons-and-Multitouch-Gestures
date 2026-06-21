'use strict';
// Build an unpacked Windows app with @electron/packager (no winCodeSign toolchain
// needed). RadialDeck.exe stays at NORMAL integrity (default asInvoker manifest) so it
// renders; the uiAccess privilege lives in a tiny separate C# exe (RadialDeckInput.exe)
// compiled here with csc (embeds its own uiAccess manifest) and copied alongside it.
// Output is normalized to dist/win-unpacked/ — what install-uiaccess.ps1 expects.

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { packager } = require('@electron/packager');
const pngToIco = require('png-to-ico').default;

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist');
const FINAL = path.join(OUT, 'win-unpacked');
const PNG = path.join(ROOT, 'src', 'icon.png');
const ICO = path.join(ROOT, 'src', 'icon.ico');
const INJ_DIR = path.join(__dirname, 'injector');

function buildInjector() {
  const csc = path.join(process.env.WINDIR || 'C:\\Windows',
    'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const src = path.join(INJ_DIR, 'RadialDeckInput.cs');
  const manifest = path.join(INJ_DIR, 'RadialDeckInput.manifest');
  const exe = path.join(INJ_DIR, 'RadialDeckInput.exe');
  execFileSync(csc, [
    '/nologo', '/target:winexe', '/platform:x64',
    `/win32manifest:${manifest}`, `/out:${exe}`, src,
  ], { stdio: 'inherit' });
  return exe;
}

(async () => {
  // regenerate the multi-size .ico from icon.png so the exe icon stays in sync
  fs.writeFileSync(ICO, await pngToIco(PNG));

  // clean previous output
  fs.rmSync(FINAL, { recursive: true, force: true });

  const paths = await packager({
    dir: ROOT,
    out: OUT,
    overwrite: true,
    platform: 'win32',
    arch: 'x64',
    name: 'RadialDeck',
    icon: ICO,
    prune: true, // app has no production deps; keeps the bundle small
    ignore: [
      /^[\\/]node_modules([\\/]|$)/,
      /^[\\/]dist([\\/]|$)/,
      /^[\\/]build([\\/]|$)/,
      /^[\\/]\.git([\\/]|$)/,
    ],
  });

  const built = paths[0]; // e.g. dist/RadialDeck-win32-x64
  // normalize to dist/win-unpacked
  fs.renameSync(built, FINAL);

  // compile the uiAccess injector and drop it next to RadialDeck.exe
  const injExe = buildInjector();
  fs.copyFileSync(injExe, path.join(FINAL, 'RadialDeckInput.exe'));

  console.log('Built (normal integrity) + injector bundled:', FINAL);
  console.log('Next: run build\\install-uiaccess.ps1 as administrator (signs both exes).');
})().catch((e) => { console.error(e); process.exit(1); });
