'use strict';
// "Close & remember" / "Reopen last closed".
//
// Before a close gesture fires its keystroke we snapshot the foreground window (RDSnap.exe)
// and push it on a stack; the reopen gesture pops it and puts the thing back.
//
// How each kind comes back:
//   explorer -> explorer.exe "<folder>"                       (exact)
//   browser  -> Ctrl+Shift+T to the browser, which restores the tab itself. If the browser
//               is gone entirely we relaunch its exe first, then send the keys.
//   file     -> relaunch the ORIGINAL exe with the file path, so a .psd reopens in Photoshop
//               rather than whatever the shell association says.
//   app      -> nothing recoverable; just relaunch the exe bare.

const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const MAX = 25;

function snapPath() {
  const cands = [
    path.join(path.dirname(process.execPath), 'RDSnap.exe'),
    path.join(__dirname, '..', 'build', 'winsnap', 'RDSnap.exe'),
  ];
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch {} }
  return null;
}

class CloseStack {
  constructor(opts) { this.opts = opts || {}; this.stack = []; }
  log(m) { try { if (this.opts.log) this.opts.log(m); } catch {} }

  // Snapshot the foreground window, then run `then()` (which sends the close keystroke).
  // Always calls then() — a failed snapshot must never swallow the user's close.
  capture(then) {
    const exe = snapPath();
    if (!exe) { this.log('RDSnap.exe not found'); return then(); }
    let done = false;
    const go = (info) => {
      if (done) return; done = true;
      if (info && (info.exe || info.target)) {
        info.t = Date.now();
        this.stack.push(info);
        if (this.stack.length > MAX) this.stack.shift();
        this.log('remembered ' + info.kind + ' ' + (info.target || info.exe));
      }
      then();
    };
    try {
      execFile(exe, { timeout: 1500, windowsHide: true }, (err, stdout) => {
        if (err) { this.log('snap err ' + err.message); return go(null); }
        try { go(JSON.parse(String(stdout).trim())); } catch (e) { this.log('snap parse ' + e); go(null); }
      });
    } catch (e) { this.log('snap spawn ' + e); go(null); }
    // safety: never let a hung snapshot block the close
    setTimeout(() => go(null), 1600);
  }

  reopenLast() {
    const it = this.stack.pop();
    if (!it) { this.log('nothing to reopen'); return null; }
    this.log('reopening ' + it.kind + ' ' + (it.target || it.exe));
    try {
      if (it.kind === 'explorer' && it.target) {
        spawn('explorer.exe', [it.target], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
      } else if (it.kind === 'file' && it.target && it.exe) {
        spawn(it.exe, [it.target], { detached: true, stdio: 'ignore' }).unref();
      } else if (it.kind === 'browser') {
        return it;   // caller focuses the browser and sends Ctrl+Shift+T
      } else if (it.exe) {
        spawn(it.exe, [], { detached: true, stdio: 'ignore' }).unref();
      }
    } catch (e) { this.log('reopen failed ' + e); }
    return null;
  }
}

module.exports = { CloseStack };
