'use strict';
// Shared helper: inject uiAccess="true" into a packed Windows exe's manifest.
// Surgically edits the EXISTING manifest so Electron's own settings (DPI awareness,
// etc.) are preserved — we only flip/add the uiAccess attribute.

const fs = require('fs');
const ResEdit = require('resedit');
const RT_MANIFEST = 24;

function patchManifestXml(xml) {
  if (/uiAccess\s*=\s*"[^"]*"/i.test(xml)) {
    return xml.replace(/uiAccess\s*=\s*"[^"]*"/i, 'uiAccess="true"');
  }
  if (/<requestedExecutionLevel\b[^>]*\blevel\s*=/i.test(xml)) {
    return xml.replace(/(<requestedExecutionLevel\b[^>]*\blevel\s*=\s*"[^"]*")/i, '$1 uiAccess="true"');
  }
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

function patchExeManifest(exePath) {
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath));
  const res = ResEdit.NtExecutableResource.from(exe);
  const entry = res.entries.find((e) => e.type === RT_MANIFEST);
  if (!entry) throw new Error('No RT_MANIFEST resource in ' + exePath);
  const xml = Buffer.from(entry.bin).toString('utf8').replace(/^﻿/, '');
  entry.bin = Buffer.from(patchManifestXml(xml), 'utf8');
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
}

module.exports = { patchManifestXml, patchExeManifest };
