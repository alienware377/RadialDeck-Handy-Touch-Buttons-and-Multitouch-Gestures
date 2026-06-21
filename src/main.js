'use strict';
const { app, BrowserWindow, ipcMain, Tray, Menu, globalShortcut, screen, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./store');
const { Keyboard } = require('./keyboard');
const { TouchTracker } = require('./touch');

// ---- UIAccess + Chromium child-process workaround ----
// With uiAccess="true" the exe gets a higher-integrity token, and Chromium's
// out-of-process children can't spawn at that integrity:
//   * GPU process  → "launch failed: error_code=18" ×9 → "GPU isn't usable. Goodbye." (app dies)
//   * Network svc  → "Network service crashed, restarting service." in an endless loop
// The network service is fatal-but-silent: in modern Chromium ALL resource loads —
// including the renderer's own file:// HTML/CSS/JS — go through it, so when it can't
// start the windows just render BLANK (no error dialog).
// Fix: keep every Chromium service IN-PROCESS (same integrity as the parent) and
// drop the sandbox. Hardware accel is unnecessary for this lightweight overlay.
// NOTE: RadialDeck.exe runs at NORMAL integrity (manifest: asInvoker, NO uiAccess) so
// Chromium can spawn its renderer/GPU/network children and actually render. The uiAccess
// privilege needed to drive elevated/admin windows lives in a tiny separate signed exe
// (RadialDeckInput.exe) that keyboard.js launches and talks to over a named pipe.

let overlayWin = null;
let editorWin = null;
let tray = null;
let kb = null;
let cfg = null;
let touch = null;

// ---- synthetic cursor (Windows hides the real arrow while a finger is touching,
// so during touchpad use we draw our own sprite that tracks the injected cursor) ----
let cursorWin = null;
let cursorTick = null;     // interval following the OS cursor position
let cursorIdle = null;     // hide after touch goes quiet
const CURSOR_HOT_X = 3, CURSOR_HOT_Y = 3;   // arrow tip offset inside cursor.html

function createCursorWin() {
  cursorWin = new BrowserWindow({
    width: 30, height: 30, frame: false, transparent: true, alwaysOnTop: true,
    skipTaskbar: true, resizable: false, movable: false, focusable: false,
    hasShadow: false, show: false, fullscreenable: false,
    webPreferences: {},
  });
  cursorWin.setAlwaysOnTop(true, 'screen-saver');
  cursorWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  cursorWin.setIgnoreMouseEvents(true, { forward: true }); // never blocks input
  cursorWin.loadFile(path.join(__dirname, 'cursor.html'));
}
function positionCursorWin() {
  if (!cursorWin || cursorWin.isDestroyed()) return;
  const p = screen.getCursorScreenPoint();
  cursorWin.setPosition(p.x - CURSOR_HOT_X, p.y - CURSOR_HOT_Y);
}
// called on every touchpad move/click: show + follow the cursor, auto-hide when idle
function pokeCursor() {
  if (!cursorWin || cursorWin.isDestroyed()) createCursorWin();
  if (!cursorWin.isVisible()) { positionCursorWin(); cursorWin.showInactive(); }
  if (!cursorTick) cursorTick = setInterval(positionCursorWin, 16);
  clearTimeout(cursorIdle);
  cursorIdle = setTimeout(hideCursorWin, 900);
}
function hideCursorWin() {
  clearInterval(cursorTick); cursorTick = null;
  clearTimeout(cursorIdle); cursorIdle = null;
  if (cursorWin && !cursorWin.isDestroyed() && cursorWin.isVisible()) cursorWin.hide();
}

// ---- last-app-point tracking ----
// Both the physical mouse and the touchpad's synthetic cursor drive the ONE OS
// cursor, so "whichever was updated last" is simply the latest cursor position
// that isn't sitting on our deck. We poll it so a scroll can target that panel
// even when the user has since moved the pointer onto the scroll widget itself.
let lastAppPoint = null;     // last cursor (mouse/touchpad) point not over the deck
let lastAppTime = 0;         // when the cursor last *moved* to a new app point
let prevCursor = null;
let appPointTimer = null;
function pointInWin(win, p) {
  if (!win || win.isDestroyed() || !win.isVisible()) return false;
  const b = win.getBounds();
  return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
}
function trackAppPoint() {
  const p = screen.getCursorScreenPoint();
  if (pointInWin(overlayWin, p)) return; // ignore the deck; remember real-app points only
  if (!prevCursor || prevCursor.x !== p.x || prevCursor.y !== p.y) lastAppTime = Date.now(); // moved
  prevCursor = p;
  lastAppPoint = p;
}
function startAppPointTracking() {
  if (appPointTimer) return;
  appPointTimer = setInterval(trackAppPoint, 60);
}

// Last DIRECT screen touch that landed on a real app (not our deck). Updated from
// the touch tracker's per-contact callback, filtered by deck bounds at touch time —
// so dragging the scroll widget (which is touch ON the deck) never clobbers it.
let lastTouchAppPoint = null;
let lastTouchAppTime = 0;

// Pick the scroll target: whichever input updated most recently — the mouse/
// touchpad cursor (lastAppPoint) or a direct screen touch (lastTouchAppPoint).
function chooseScrollPoint() {
  if (lastTouchAppPoint && lastTouchAppTime >= lastAppTime) return lastTouchAppPoint;
  return lastAppPoint;
}

const ICON = path.join(__dirname, 'icon.png');

function centeredPos(size) {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: Math.round(wa.x + wa.width / 2 - size / 2), y: Math.round(wa.y + wa.height / 2 - size / 2) };
}

// true if the window's CENTRE (where the draggable orb lives) is off the work area,
// i.e. the orb would be unreachable. Center-based so a half-clipped window still counts.
function isOffScreen(box) {
  const wa = screen.getDisplayMatching(box).workArea;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2, m = 24;
  return cx < wa.x + m || cx > wa.x + wa.width - m || cy < wa.y + m || cy > wa.y + wa.height - m;
}

// if the overlay ended up off-screen, recenter it (recovers a window dragged into the void)
function ensureOnScreen() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const b = overlayWin.getBounds();
  if (!isOffScreen(b)) return;
  const { x, y } = centeredPos(Math.max(b.width, b.height));
  overlayWin.setBounds({ x, y, width: b.width, height: b.height });
  cfg.overlay.x = x; cfg.overlay.y = y; store.save(cfg);
}

// Tell the input helper to RegisterTouchWindow on the overlay so Windows stops
// promoting physical touch on it to OS mouse moves / pan gestures (which otherwise
// warp the cursor to the finger and scroll whatever window is under it). The overlay
// is WS_EX_NOACTIVATE + transparent, so without this Windows runs the legacy touch
// path on it. Called a few times because the helper transport may still be spinning up.
function registerOverlayTouch() {
  if (!kb || !overlayWin || overlayWin.isDestroyed()) return;
  let hex = null;
  try {
    const buf = overlayWin.getNativeWindowHandle();
    if (buf && buf.length >= 8) hex = buf.readBigUInt64LE(0).toString(16);
    else if (buf && buf.length >= 4) hex = (buf.readUInt32LE(0) >>> 0).toString(16);
  } catch {}
  if (!hex) return;
  kb.registerTouchWindow(hex);
  // re-assert: transport may connect late, and re-creating the window invalidates it
  [300, 1000, 2500].forEach((ms) => setTimeout(() => {
    if (kb && overlayWin && !overlayWin.isDestroyed()) kb.registerTouchWindow(hex);
  }, ms));
}

function createOverlay() {
  const initial = 360;
  let x = cfg.overlay.x, y = cfg.overlay.y;
  if (x == null || y == null || isOffScreen({ x, y, width: initial, height: initial })) ({ x, y } = centeredPos(initial));

  overlayWin = new BrowserWindow({
    width: initial, height: initial, x, y,
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
    resizable: false, movable: false,
    focusable: false, // keystrokes reach the app underneath; clicks still register
    hasShadow: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.setIgnoreMouseEvents(false); // capture-at-rest so touch/pen taps register; renderer toggles through over empty gaps
  overlayWin.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWin.once('ready-to-show', () => {
    overlayWin.setBounds({ x, y, width: initial, height: initial });
    overlayWin.show(); // renderer immediately re-fits via set-overlay-bounds
    registerOverlayTouch();
  });
  overlayWin.on('show', registerOverlayTouch);
}

function createEditor() {
  if (editorWin && !editorWin.isDestroyed()) { editorWin.focus(); return; }
  editorWin = new BrowserWindow({
    width: 1060, height: 720, minWidth: 820, minHeight: 560,
    title: 'RadialDeck — Layout Editor', icon: ICON, backgroundColor: '#15171c',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  editorWin.setMenuBarVisibility(false);
  editorWin.loadFile(path.join(__dirname, 'editor.html'));
  editorWin.on('closed', () => { editorWin = null; });
}

function broadcastConfig() {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('config', cfg);
  if (editorWin && !editorWin.isDestroyed()) editorWin.webContents.send('config', cfg);
}

function buildTray() {
  let img = nativeImage.createFromPath(ICON);
  if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 });
  try { tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img); } catch { return; }
  tray.setToolTip('RadialDeck');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show / Hide overlay', click: toggleOverlay },
    { label: 'Edit layouts…', click: createEditor },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
  tray.on('click', toggleOverlay);
}

function toggleOverlay() {
  if (!overlayWin || overlayWin.isDestroyed()) { createOverlay(); return; }
  if (overlayWin.isVisible()) overlayWin.hide();
  else { ensureOnScreen(); overlayWin.show(); }
}

// ---------- IPC ----------
ipcMain.handle('get-config', () => cfg);

ipcMain.on('save-config', (_e, newCfg) => { cfg = newCfg; store.save(cfg); broadcastConfig(); });

ipcMain.on('set-active-layout', (_e, idx) => { cfg.activeLayout = idx; store.save(cfg); broadcastConfig(); });

ipcMain.on('key-action', (_e, msg) => {
  if (!kb) return;
  const { id, combo, action, phase } = msg;
  if (action === 'press') kb.press(combo);
  else if (action === 'command') runCommand(combo);
  else if (action === 'hold') { if (phase === 'down') kb.holdDown(id, combo); else kb.holdUp(id); }
  else if (action === 'toggle') {
    if (phase === 'down') {
      const on = kb.toggle(id, combo);
      if (overlayWin) overlayWin.webContents.send('toggle-state', { id, on });
    }
  }
});

ipcMain.on('scroll-begin', () => { if (kb) kb.captureScrollTarget(chooseScrollPoint()); });
ipcMain.on('scroll', (_e, { amount, horizontal }) => { if (kb) kb.wheel(amount, horizontal); });

ipcMain.on('tp-move', (_e, { dx, dy }) => { if (kb) kb.mouseMove(dx, dy); pokeCursor(); });
ipcMain.on('tp-button', (_e, { action, button, clicks }) => { if (kb) kb.mouseButton(action, button, clicks); pokeCursor(); });

ipcMain.on('set-click-through', (_e, ignore) => {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.setIgnoreMouseEvents(ignore, { forward: true });
});

// renderer is the source of truth for overlay size + position (it knows the DOM layout)
ipcMain.on('set-overlay-bounds', (_e, b) => {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  overlayWin.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.max(1, Math.round(b.width)), height: Math.max(1, Math.round(b.height)) });
  if (b.persist) {
    cfg.overlay.x = Math.round(b.x); cfg.overlay.y = Math.round(b.y);
    if (typeof b.collapsed === 'boolean') cfg.overlay.collapsed = b.collapsed;
    store.save(cfg);
  }
});

// Let the editor pick a local image for a button icon. We read it here (renderer
// has no fs) and return a data URL so it persists inside config.json and renders
// in both the editor and the overlay. Raster images are downscaled to <=256px to
// keep the config small; SVGs are embedded verbatim (already tiny + crisp).
ipcMain.handle('pick-image', async () => {
  try {
    const r = await dialog.showOpenDialog(editorWin || undefined, {
      title: 'Choose button image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'] }],
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return null;
    const fp = r.filePaths[0];
    const ext = path.extname(fp).slice(1).toLowerCase();
    const buf = fs.readFileSync(fp);
    if (ext === 'svg') return 'data:image/svg+xml;base64,' + buf.toString('base64');
    let img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) return null;
    const sz = img.getSize();
    const max = Math.max(sz.width, sz.height);
    if (max > 256) {
      const scale = 256 / max;
      img = img.resize({ width: Math.round(sz.width * scale), height: Math.round(sz.height * scale), quality: 'best' });
    }
    return img.toDataURL();
  } catch { return null; }
});

ipcMain.on('open-editor', createEditor);
ipcMain.on('hide-overlay', () => { if (overlayWin) overlayWin.hide(); });

function runCommand(cmd) {
  if (!cmd) return;
  require('child_process').exec(cmd, { windowsHide: true }, () => {});
}

// ---------- lifecycle ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (overlayWin) { ensureOnScreen(); overlayWin.show(); } createEditor(); });

  app.whenReady().then(() => {
    cfg = store.load();
    kb = new Keyboard();
    touch = new TouchTracker((x, y, t) => {
      const p = { x, y };
      if (pointInWin(overlayWin, p)) return; // touched the deck (e.g. scroll widget) — not an app
      lastTouchAppPoint = p; lastTouchAppTime = t;
    });
    createOverlay();
    startAppPointTracking();
    buildTray();
    globalShortcut.register('Control+Alt+Space', toggleOverlay);
    globalShortcut.register('Control+Alt+E', createEditor);
  });

  app.on('will-quit', () => { globalShortcut.unregisterAll(); if (kb) kb.dispose(); if (touch) touch.dispose(); hideCursorWin(); });
  app.on('window-all-closed', () => { /* stay alive in tray */ });
}
