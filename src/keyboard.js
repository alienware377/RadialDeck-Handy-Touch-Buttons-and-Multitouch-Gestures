'use strict';
// Reliable, zero-native-dependency keystroke injection for Windows.
// We keep one long-lived PowerShell process alive. It P/Invokes user32!keybd_event.
// Node owns all the smarts (virtual-key mapping, combo parsing); PowerShell just
// presses/releases a single virtual key on command -> low latency, no recompiles.

const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');

const PIPE_PATH = '\\\\.\\pipe\\RadialDeckInput';
const INJECTOR_EXE = 'RadialDeckInput.exe';

// Virtual-Key codes. https://learn.microsoft.com/windows/win32/inputdev/virtual-key-codes
const VK = {
  // modifiers
  ctrl: 0x11, control: 0x11, lctrl: 0xa2, rctrl: 0xa3,
  alt: 0x12, menu: 0x12, lalt: 0xa4, ralt: 0xa5,
  shift: 0x10, lshift: 0xa0, rshift: 0xa1,
  win: 0x5b, meta: 0x5b, super: 0x5b, lwin: 0x5b, rwin: 0x5c,
  // whitespace / control
  enter: 0x0d, return: 0x0d, tab: 0x09, space: 0x20, spacebar: 0x20,
  backspace: 0x08, bksp: 0x08, esc: 0x1b, escape: 0x1b,
  delete: 0x2e, del: 0x2e, insert: 0x2d, ins: 0x2d,
  home: 0x24, end: 0x23, pageup: 0x21, pgup: 0x21, pagedown: 0x22, pgdn: 0x22,
  capslock: 0x14,
  // arrows
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  // function keys
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
  f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b,
  // symbols (US layout OEM keys)
  ';': 0xba, '=': 0xbb, ',': 0xbc, '-': 0xbd, '.': 0xbe, '/': 0xbf,
  '`': 0xc0, '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde,
  // numpad
  num0: 0x60, num1: 0x61, num2: 0x62, num3: 0x63, num4: 0x64,
  num5: 0x65, num6: 0x66, num7: 0x67, num8: 0x68, num9: 0x69,
  nummult: 0x6a, numadd: 0x6b, numsub: 0x6d, numdec: 0x6e, numdiv: 0x6f,
  // media
  volup: 0xaf, voldown: 0xae, volmute: 0xad,
  medianext: 0xb0, mediaprev: 0xb1, mediastop: 0xb2, mediaplay: 0xb3,
};

// Keys that require the KEYEVENTF_EXTENDEDKEY flag to behave correctly.
const EXTENDED = new Set([
  0x2e, 0x2d, 0x24, 0x23, 0x21, 0x22, 0x26, 0x28, 0x25, 0x27, // del/ins/home/end/pg/arrows
  0x6f, 0x0d, 0xa3, 0xa5, 0xa1, 0x5b, 0x5c, 0xaf, 0xae, 0xad, 0xb0, 0xb1, 0xb2, 0xb3,
]);

function vkFor(token) {
  if (!token) return null;
  const t = String(token).toLowerCase().trim();
  if (t in VK) return VK[t];
  // single character a-z 0-9 map directly to their ASCII uppercase VK
  if (t.length === 1) {
    const c = t.toUpperCase().charCodeAt(0);
    if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a)) return c;
    if (t in VK) return VK[t];
  }
  return null;
}

// Parse "ctrl+shift+s" -> [0x11, 0x10, 0x53]
function parseCombo(combo) {
  if (!combo) return [];
  return String(combo)
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(vkFor)
    .filter((v) => v != null);
}

const PS_HELPER = `
$ErrorActionPreference='Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class RD {
  [DllImport("user32.dll")]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")]
  public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
  [DllImport("user32.dll")]
  public static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO lpgui);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")]
  public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")]
  public static extern int GetSystemMetrics(int nIndex);
  [DllImport("user32.dll")]
  public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")]
  public static extern bool RegisterTouchWindow(IntPtr hWnd, uint ulFlags);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc cb, IntPtr lParam);
  // Register the whole HWND subtree: Electron delivers touch to a CHILD render-widget
  // HWND, so registering only the top-level leaves the pan/flick gesture engine live on
  // the child (one-finger drag still scrolls the window under the cursor).
  public static void RegisterTouchTree(IntPtr h) {
    RegisterTouchWindow(h, 0);
    EnumChildWindows(h, delegate(IntPtr c, IntPtr l) { RegisterTouchWindow(c, 0); return true; }, IntPtr.Zero);
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int x, y; }
  [StructLayout(LayoutKind.Sequential)]
  public struct GUITHREADINFO {
    public int cbSize; public int flags;
    public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
    public RECT rcCaret;
  }
}
"@
# the window we deliver wheel events to: captured when a scroll gesture begins so
# scrolling always lands on whatever the user had focused, never on the overlay.
$target=[IntPtr]::Zero; $tx=0; $ty=0
while($true){
  $line = [Console]::In.ReadLine()
  if($line -eq $null){ break }
  $p = $line.Split(' ')
  if($p.Length -lt 2){ continue }
  try {
    if($p[0] -eq 'F'){
      # Aim the wheel at a SCREEN POINT. Real wheel injection (mouse_event) is
      # hit-tested by the OS at the cursor, so we relocate the cursor there at
      # scroll time -> reaches Chromium/Electron apps that ignore posted messages.
      # main.js passes the last point where ANY cursor (mouse or the touchpad's
      # synthetic cursor, whichever moved last) was over a real app, NOT our deck.
      $px=[int]$p[1]; $py=[int]$p[2]
      if($px -ne 0 -or $py -ne 0){
        $pt = New-Object RD+POINT; $pt.x=$px; $pt.y=$py
        $w = [RD]::WindowFromPoint($pt)
        $target = if($w -ne [IntPtr]::Zero){ $w } else { [RD]::GetForegroundWindow() }
        $tx=$px; $ty=$py
      } else {
        # no tracked point yet -> fall back to the foreground app's focused control
        $fg = [RD]::GetForegroundWindow(); $target = $fg
        $tid = [RD]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
        $gti = New-Object RD+GUITHREADINFO
        $gti.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($gti)
        if([RD]::GetGUIThreadInfo($tid, [ref]$gti) -and $gti.hwndFocus -ne [IntPtr]::Zero){ $target = $gti.hwndFocus }
        $r = New-Object RD+RECT
        if([RD]::GetWindowRect($target, [ref]$r)){ $tx=[int](($r.left+$r.right)/2); $ty=[int](($r.top+$r.bottom)/2) } else { $tx=0; $ty=0 }
      }
      continue
    }
    if($p[0] -eq 'RTW'){ # register overlay HWND subtree for touch -> kills OS touch->mouse promotion + pan gestures
      [RD]::RegisterTouchTree([IntPtr][Convert]::ToInt64($p[1],16))
      continue
    }
    if($p[0] -eq 'MV'){ # ABSOLUTE injected move: no pointer-accel mangling AND a real move
      # event so click-and-drag (terminal text selection etc.) registers, unlike SetCursorPos.
      $c = New-Object RD+POINT
      if([RD]::GetCursorPos([ref]$c)){
        $tx=$c.x+[int]$p[1]; $ty=$c.y+[int]$p[2]
        $vx=[RD]::GetSystemMetrics(76); $vy=[RD]::GetSystemMetrics(77)
        $vw=[RD]::GetSystemMetrics(78); $vh=[RD]::GetSystemMetrics(79)
        if($vw -le 1 -or $vh -le 1){ [void][RD]::SetCursorPos($tx,$ty) }
        else {
          if($tx -lt $vx){$tx=$vx} elseif($tx -gt $vx+$vw-1){$tx=$vx+$vw-1}
          if($ty -lt $vy){$ty=$vy} elseif($ty -gt $vy+$vh-1){$ty=$vy+$vh-1}
          $nx=[int]([int64]($tx-$vx)*65535/($vw-1)); $ny=[int]([int64]($ty-$vy)*65535/($vh-1))
          [RD]::mouse_event([uint32]0xC001,$nx,$ny,0,[UIntPtr]::Zero) # MOVE|ABSOLUTE|VIRTUALDESK
        }
      }
      continue
    }
    if($p[0] -eq 'MB'){ [RD]::mouse_event([uint32]$p[1],0,0,0,[UIntPtr]::Zero); continue }            # raw button flag
    if($p[0] -eq 'W' -or $p[0] -eq 'H'){
      $delta=[int]$p[1]
      $f = if($p[0] -eq 'H'){ [uint32]0x01000 } else { [uint32]0x0800 } # MOUSEEVENTF_HWHEEL / WHEEL
      if($target -ne [IntPtr]::Zero -and ($tx -ne 0 -or $ty -ne 0)){
        # real wheel injection: hop the cursor onto the captured panel, fire a genuine
        # wheel (OS hit-tests at the cursor -> reaches Chromium/Electron too), hop back.
        $old = New-Object RD+POINT
        $have = [RD]::GetCursorPos([ref]$old)
        [void][RD]::SetCursorPos($tx,$ty)
        [RD]::mouse_event($f,0,0,$delta,[UIntPtr]::Zero)
        if($have){ [void][RD]::SetCursorPos($old.x,$old.y) }
      } else {
        [RD]::mouse_event($f,0,0,$delta,[UIntPtr]::Zero) # no target -> under-cursor
      }
      continue
    }
    $vk = [byte][Convert]::ToInt32($p[1],16)
    $ext = if($p.Length -ge 3 -and $p[2] -eq '1'){ [uint32]1 } else { [uint32]0 }
    if($p[0] -eq 'D'){ [RD]::keybd_event($vk,0,$ext,[UIntPtr]::Zero) }
    elseif($p[0] -eq 'U'){ [RD]::keybd_event($vk,0,($ext -bor 2),[UIntPtr]::Zero) }
  } catch {}
}
`;

class Keyboard {
  constructor() {
    this.pipe = null;        // net.Socket to the uiAccess injector (preferred)
    this.proc = null;        // inline PowerShell helper (fallback, dev / injector missing)
    this._queue = [];        // commands buffered until a transport is ready
    this._disposed = false;
    this._connecting = false; // a connect() socket is in flight (single-flight guard)
    this._connTimer = null;   // pending retry/reconnect timer (single-flight guard)
    this._psStopping = false; // _stopPS set this so the exit handler skips auto-respawn
    this.held = new Map();   // id -> [vk,...] for hold buttons
    this.toggled = new Map(); // id -> [vk,...] for toggle buttons currently down
    this._start();
  }

  // Locate the injector exe: next to the running exe (prod / Program Files), or the
  // dev build output. Returns null if not found (-> PowerShell fallback).
  _injectorPath() {
    const candidates = [
      path.join(path.dirname(process.execPath), INJECTOR_EXE),
      path.join(__dirname, '..', 'build', 'injector', INJECTOR_EXE),
    ];
    for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch {} }
    return null;
  }

  _start() {
    // The PS fallback gives INSTANT input but runs at normal integrity (UIPI blocks it
    // from elevated windows). The uiAccess injector is required for elevated targets, but
    // its first launch (Authenticode/cert-chain verification + .NET cold start) can take
    // several seconds. So start PS now for immediate input AND bring up the injector in
    // parallel; the moment the injector's pipe is reachable we switch to it and tear PS
    // down. Without this the app would permanently sit on PS and never drive elevated apps.
    if (this._disposed) return;
    this._startPS();
    this._ensureInjector();
    this._connect(0);
  }

  // Launch the uiAccess injector via ShellExecute (Start-Process). CreateProcess of a
  // uiAccess exe fails "requires elevation", and ShellExecute can't redirect stdio —
  // hence the named pipe. The injector is single-instance (its own mutex), so launching
  // a second time while one is up is a harmless no-op.
  _ensureInjector() {
    const exe = this._injectorPath();
    if (!exe) return;
    try {
      spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
        `Start-Process -FilePath '${exe.replace(/'/g, "''")}' -ArgumentList '${process.pid}'`,
      ], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    } catch {}
  }

  // Single-flight connect: exactly one in-flight socket (_connecting) and one pending
  // timer (_connTimer) at a time. The old version started a fresh retry chain on every
  // _start/close, so overlapping chains raced — each connect/close pair spawned another PS
  // stopgap that never got cleaned up (50+ orphaned powershell.exe in seconds).
  _connect(attempt) {
    if (this._disposed || this.pipe || this._connecting) return;
    this._connecting = true;
    const sock = net.connect(PIPE_PATH);

    // error + close share ONE idempotent teardown. Critically the listeners are .on()
    // (PERSISTENT), not .once(): an async write failure (EPIPE — the injector pipe dropped,
    // e.g. injector restart / owner-pid exit) emits 'error' on the socket. With .once() the
    // first error consumed the handler, so the NEXT error had no listener and Node threw it
    // as an uncaught exception, crashing the Electron main process ("A JavaScript error
    // occurred in the main process: write EPIPE"). A persistent handler + the `settled` guard
    // means a write error can never be uncaught and we just fall back to PS and reconnect.
    let settled = false;
    const fail = () => {
      if (settled) return; settled = true;
      this._connecting = false;
      const wasLive = (this.pipe === sock); // a live pipe dropped vs a connect attempt failing
      if (wasLive) this.pipe = null;        // stop routing writes to a dead pipe immediately
      try { sock.destroy(); } catch {}
      if (this._disposed) return;
      if (wasLive) this._startPS();         // immediate normal-integrity stopgap while we recover
      if (this.pipe || this._connTimer) return;
      // Retry FOREVER (with backoff), never give up. On a cold boot the injector's first launch
      // (Authenticode/cert-chain verification + .NET cold start) can take far longer than any
      // fixed cap — and AV/disk contention can stretch it to minutes. If we stop retrying, the
      // app silently sits on the normal-integrity PS fallback forever (UIPI then blocks elevated
      // targets -> "scrolling broke again"). PS covers input the whole time, so a slow poll is
      // invisible. Re-launch the injector periodically in case the first spawn lost the race.
      const delay = wasLive ? 800 : (attempt < 40 ? 200 : (attempt < 80 ? 1000 : 3000));
      const next = wasLive ? 0 : attempt + 1;
      if (next > 0 && next % 20 === 0) this._ensureInjector();
      this._connTimer = setTimeout(() => { this._connTimer = null; this._connect(next); }, delay);
    };

    sock.on('connect', () => {
      this._connecting = false;
      this.pipe = sock;
      this._stopPS();  // uiAccess injector takes over from the normal-integrity stopgap
      this._flush();
    });
    sock.on('error', fail);  // PERSISTENT: never let an async write EPIPE become uncaught
    sock.on('close', fail);
  }

  _startPS() {
    if (this.proc || this._disposed || this.pipe) return;
    this._psStopping = false;
    this.proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
      { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true }
    );
    this.proc.stdin.write(PS_HELPER + '\n');
    this._flush();
    this.proc.on('exit', () => {
      const intentional = this._psStopping; this._psStopping = false;
      this.proc = null;
      // auto-respawn only if it died on its own AND the injector hasn't taken over
      if (!this._disposed && !intentional && !this.pipe) setTimeout(() => this._startPS(), 500);
    });
  }

  // Tear down the PS stopgap once the injector pipe is live (flag suppresses the respawn).
  // child.kill() proved unreliable here — a powershell blocked in [Console]::In.ReadLine()
  // sometimes survived SIGTERM, leaving an idle orphan. taskkill /F /T guarantees the
  // process (and any csc.exe it spawned) is gone.
  _stopPS() {
    if (!this.proc) return;
    this._psStopping = true;
    const p = this.proc; this.proc = null;
    this._killProc(p);
  }

  _killProc(p) {
    if (!p) return;
    try { p.stdin.end(); } catch {}
    try { p.kill(); } catch {}
    if (p.pid) {
      // absolute path: a packaged Electron app may not have System32 on PATH, so a bare
      // 'taskkill' spawns ENOENT (swallowed by the error handler) and the orphan survives.
      const tk = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
      try {
        spawn(tk, ['/PID', String(p.pid), '/F', '/T'],
          { stdio: 'ignore', windowsHide: true }).on('error', () => {});
      } catch {}
    }
  }

  // route a protocol line to whichever transport is live, else buffer it
  _send(line) {
    if (this.pipe && this.pipe.writable) { try { this.pipe.write(line + '\n'); return; } catch {} }
    if (this.proc && this.proc.stdin.writable) { try { this.proc.stdin.write(line + '\n'); return; } catch {} }
    if (this._queue.length < 256) this._queue.push(line);
  }
  _flush() {
    if (!this._queue.length) return;
    const q = this._queue; this._queue = [];
    for (const l of q) this._send(l);
  }

  _down(vk) {
    const ext = EXTENDED.has(vk) ? ' 1' : '';
    this._send(`D ${vk.toString(16)}${ext}`);
  }
  _up(vk) {
    const ext = EXTENDED.has(vk) ? ' 1' : '';
    this._send(`U ${vk.toString(16)}${ext}`);
  }

  // tap a full combo: press modifiers->key, release key->modifiers
  press(combo) {
    const vks = parseCombo(combo);
    if (!vks.length) return;
    for (const v of vks) this._down(v);
    for (let i = vks.length - 1; i >= 0; i--) this._up(vks[i]);
  }

  // hold down while button held; release on key-up
  holdDown(id, combo) {
    const vks = parseCombo(combo);
    if (!vks.length) return;
    for (const v of vks) this._down(v);
    this.held.set(id, vks);
  }
  holdUp(id) {
    const vks = this.held.get(id);
    if (!vks) return;
    for (let i = vks.length - 1; i >= 0; i--) this._up(vks[i]);
    this.held.delete(id);
  }

  // toggle: first tap holds keys down, second tap releases them
  toggle(id, combo) {
    if (this.toggled.has(id)) {
      const vks = this.toggled.get(id);
      for (let i = vks.length - 1; i >= 0; i--) this._up(vks[i]);
      this.toggled.delete(id);
      return false; // now off
    }
    const vks = parseCombo(combo);
    if (!vks.length) return false;
    for (const v of vks) this._down(v);
    this.toggled.set(id, vks);
    return true; // now on
  }

  // remember the window/control the user has focused right now, so the wheel that
  // follows scrolls THAT window instead of the overlay sitting under the cursor.
  // Called when a scroll gesture begins (overlay is focusable:false, so the user's
  // app is still the foreground window at this moment).
  // point: { x, y } screen coords (DIP) of the last app panel a cursor was over,
  // or null to let the helper fall back to the foreground window's focused control.
  captureScrollTarget(point) {
    if (point && (point.x || point.y)) this._send(`F ${Math.round(point.x)} ${Math.round(point.y)}`);
    else this._send(`F 0 0`);
  }

  // mouse wheel. amount in wheel units (120 = one notch). positive = up, negative = down.
  // Delivered via WM_MOUSEWHEEL straight to the captured target (see captureScrollTarget).
  wheel(amount, horizontal) {
    if (!amount) return;
    this._send(`${horizontal ? 'H' : 'W'} ${Math.round(amount)}`);
  }

  // Disable Windows' legacy touch->mouse promotion + pan/flick gestures on a window
  // (our non-activating overlay) by registering it as a touch window. hwndHex = the
  // HWND as a hex string (from BrowserWindow.getNativeWindowHandle()).
  registerTouchWindow(hwndHex) {
    if (!hwndHex) return;
    this._send(`RTW ${hwndHex}`);
  }

  // Capture mode: tell the uiAccess injector to globally claim (true) or release (false)
  // touch input, so 3+ finger gestures don't also reach the app underneath. The injector
  // auto-releases after ~1.5s if engage isn't renewed (watchdog), so this can't get stuck.
  setCapture(on) { this._send('CAP ' + (on ? '1' : '0')); }

  // ---- touchpad: move the system cursor relatively, and click mouse buttons ----
  mouseMove(dx, dy) {
    dx = Math.round(dx); dy = Math.round(dy);
    if (!dx && !dy) return;
    this._send(`MV ${dx} ${dy}`);
  }
  // action: 'down' | 'up' | 'click'; button: 'l' | 'r' | 'm'; clicks: repeat count for 'click'
  mouseButton(action, button, clicks) {
    const DN = { l: 2, r: 8, m: 32 }, UP = { l: 4, r: 16, m: 64 };
    const b = DN[button] != null ? button : 'l';
    const send = (f) => this._send(`MB ${f}`);
    if (action === 'down') return send(DN[b]);
    if (action === 'up') return send(UP[b]);
    const n = Math.max(1, Math.min(3, clicks || 1));
    for (let i = 0; i < n; i++) { send(DN[b]); send(UP[b]); }
  }

  releaseAll() {
    for (const [id] of this.held) this.holdUp(id);
    for (const [id, vks] of this.toggled) {
      for (let i = vks.length - 1; i >= 0; i--) this._up(vks[i]);
    }
    this.toggled.clear();
  }

  dispose() {
    this._disposed = true;
    if (this._connTimer) { try { clearTimeout(this._connTimer); } catch {} this._connTimer = null; }
    this.releaseAll();
    if (this.pipe) {
      try { this.pipe.end(); } catch {}
      try { this.pipe.destroy(); } catch {}
      this.pipe = null;
    }
    if (this.proc) {
      const p = this.proc; this.proc = null;
      this._killProc(p);
    }
  }
}

module.exports = { Keyboard, parseCombo, VK };
