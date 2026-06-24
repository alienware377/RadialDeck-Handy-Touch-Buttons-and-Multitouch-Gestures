'use strict';
// electron-builder afterPack hook.
//
// Injects uiAccess="true" into the packed RadialDeck.exe manifest so the app can
// drive higher-integrity (elevated, e.g. UAC-admin) windows — synthetic input from
// a normal-rights process is otherwise blocked by Windows UIPI. UIAccess additionally
// requires the exe be code-signed by a trusted cert AND live in a secure location
// (Program Files); uiaccess-setup.ps1 handles those two steps.
//
// We surgically edit the EXISTING manifest (only flip uiAccess / add a trustInfo
// block) so Electron's own settings — notably DPI awareness — stay intact.

const fs = require('fs');
const path = require('path');
const ResEdit = require('resedit');

const RT_MANIFEST = 24;

function patchManifestXml(xml) {
  if (/uiAccess\s*=\s*"[^"]*"/i.test(xml)) {
    return xml.replace(/uiAccess\s*=\s*"[^"]*"/i, 'uiAccess="true"');
  }
  if (/<requestedExecutionLevel\b[^>]*\blevel\s*=/i.test(xml)) {
    // has a level but no uiAccess attr -> add it
    return xml.replace(/(<requestedExecutionLevel\b[^>]*\blevel\s*=\s*"[^"]*")/i, '$1 uiAccess="true"');
  }
  // no trustInfo at all -> inject a full block before </assembly>
  const trustInfo =
    '  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">\n' +
    '    <security>\n' +
    '      <requestedPrivileges>\n' +
    '        <requestedExecutionLevel level="asInvoker" uiAccess="true"></requestedExecutionLevel>\n' +
    '      </requestedPrivileges>\n' +
    '    </security>\n' +
    '  </trustInfo>\n';
  return xml.replace(/<\/assembly>/i, trustInfo + '</assembly>');
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const exeName = (context.packager.appInfo.productFilename || 'RadialDeck') + '.exe';
  const exePath = path.join(context.appOutDir, exeName);
  if (!fs.existsSync(exePath)) { console.warn('[afterPack] exe not found:', exePath); return; }

  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath));
  const res = ResEdit.NtExecutableResource.from(exe);
  const manifestEntry = res.entries.find((e) => e.type === RT_MANIFEST);
  if (!manifestEntry) { console.warn('[afterPack] no RT_MANIFEST in', exeName); return; }

  let xml = Buffer.from(manifestEntry.bin).toString('utf8').replace(/^﻿/, '');
  const patched = patchManifestXml(xml);
  manifestEntry.bin = Buffer.from(patched, 'utf8');

  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log('[afterPack] uiAccess=true injected into', exeName);
};
