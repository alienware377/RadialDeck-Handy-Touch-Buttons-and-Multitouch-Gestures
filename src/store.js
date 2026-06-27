'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}
function uid() { return 'k' + Math.random().toString(36).slice(2, 9); }

// ---- item factories ----
// key:    { id, type:'key', label, combo, action:'press|hold|toggle|command', color, gx, gy, gw, gh }
// group:  { id, type:'group', label, color, gx, gy, gw, gh, items:[...] }   (nestable)
// scroll: { id, type:'scroll', label, color, gx, gy, gw, gh, axis:'v|h', step, invert }
function key(label, combo, action, color, gx, gy, gw, gh) {
  return { id: uid(), type: 'key', label, combo, action: action || 'press', color: color || '#3a3f4c',
    gx: gx || 0, gy: gy || 0, gw: gw || 1, gh: gh || 1 };
}
function group(label, color, gx, gy, gw, gh, items) {
  return { id: uid(), type: 'group', label, color: color || '#9b6cff', gx, gy, gw: gw || 1, gh: gh || 1, items: items || [] };
}
function scroll(label, color, gx, gy, gw, gh, axis) {
  return { id: uid(), type: 'scroll', label, color: color || '#46c08f', gx, gy, gw: gw || 1, gh: gh || 1,
    axis: axis || 'v', step: 1, invert: false };
}
// touchpad: { ..., expand, sensitivity, scrollSpeed, naturalScroll, gestures:[{fingers,dir,action,combo}] }
function defaultGestures() {
  return [
    { fingers: 3, dir: 'left', action: 'press', combo: 'alt+left' },   // back
    { fingers: 3, dir: 'right', action: 'press', combo: 'alt+right' },  // forward
    { fingers: 3, dir: 'up', action: 'press', combo: 'win+tab' },       // task view
    { fingers: 3, dir: 'down', action: 'press', combo: 'win+d' },       // show desktop
  ];
}
function touchpad(label, color, gx, gy, gw, gh, expand) {
  return { id: uid(), type: 'touchpad', label: label || 'Trackpad', color: color || '#e0726b',
    gx: gx || 0, gy: gy || 0, gw: gw || 3, gh: gh || 3, expand: !!expand,
    sensitivity: 1.2, scrollSpeed: 1, naturalScroll: false, gestures: defaultGestures() };
}
// mousebtn: { ..., button:'l|r|m', clicks }
function mousebtn(label, button, color, gx, gy, gw, gh, clicks) {
  return { id: uid(), type: 'mousebtn', label: label || 'Click', button: button || 'l', color: color || '#5b8cff',
    gx: gx || 0, gy: gy || 0, gw: gw || 1, gh: gh || 1, mode: 'click', clicks: clicks || 1 };
}

// ---- GLOBAL gestures (independent of the on-screen deck) ----
// A binding maps a recognized whole-screen gesture to an action. Detected by the
// background raw-input host + gestures.js recognizer, NOT by the overlay buttons.
//   kind:    'edge'  -> swipe in from a screen edge (dir: left|right)
//            'swipe' -> straight N-finger swipe (dir: up|down|left|right)
//            'tap'   -> quick N-finger tap (no/low movement)
//            'pinch' -> N fingers contract/expand (dir: in|out)
//            'rotate'-> N fingers orbit their centroid (dir: cw|ccw)
//            'path'  -> centroid traces a built-in shape (shape: circle|figure8|s|s-side|half-circle)
//            'custom'-> centroid matches a user-recorded template (points:[{x,y}...])
//   action:  'press' (combo) | 'command' (shell) | 'rd-control' (verb: toggle-deck|show-deck|
//            hide-deck|next-layout|prev-layout|collapse-toggle)
function gbind(o) {
  return Object.assign({ id: 'g' + Math.random().toString(36).slice(2, 9), name: '', kind: 'swipe',
    fingers: 3, dir: null, shape: null, points: null, action: 'press', combo: '', enabled: true }, o);
}
function defaultGlobalGestures() {
  return [
    // edge swipes
    gbind({ name: 'Left edge → summon deck', kind: 'edge', fingers: 1, dir: 'left', action: 'rd-control', combo: 'toggle-deck' }),
    gbind({ name: 'Right edge → Task View', kind: 'edge', fingers: 1, dir: 'right', action: 'press', combo: 'win+tab' }),
    // 3-finger directional
    gbind({ name: '3-finger up → Task View', kind: 'swipe', fingers: 3, dir: 'up', action: 'press', combo: 'win+tab' }),
    gbind({ name: '3-finger down → Show desktop', kind: 'swipe', fingers: 3, dir: 'down', action: 'press', combo: 'win+d' }),
    gbind({ name: '3-finger left → Back', kind: 'swipe', fingers: 3, dir: 'left', action: 'press', combo: 'alt+left' }),
    gbind({ name: '3-finger right → Forward', kind: 'swipe', fingers: 3, dir: 'right', action: 'press', combo: 'alt+right' }),
    // 4-finger directional → virtual desktops
    gbind({ name: '4-finger left → Prev desktop', kind: 'swipe', fingers: 4, dir: 'left', action: 'press', combo: 'win+ctrl+left' }),
    gbind({ name: '4-finger right → Next desktop', kind: 'swipe', fingers: 4, dir: 'right', action: 'press', combo: 'win+ctrl+right' }),
    // taps
    gbind({ name: '3-finger tap → Play/Pause', kind: 'tap', fingers: 3, action: 'press', combo: 'mediaplay' }),
    gbind({ name: '5-finger tap → summon deck', kind: 'tap', fingers: 5, action: 'rd-control', combo: 'toggle-deck' }),
    // pinch / rotate / path / custom (disabled by default so users opt in deliberately)
    gbind({ name: '5-finger pinch in → Show desktop', kind: 'pinch', fingers: 5, dir: 'in', action: 'press', combo: 'win+d', enabled: false }),
    gbind({ name: '3-finger circle → Snip', kind: 'path', fingers: 3, shape: 'circle', action: 'press', combo: 'win+shift+s', enabled: false }),
    gbind({ name: '3-finger rotate CW → Next layout', kind: 'rotate', fingers: 3, dir: 'cw', action: 'rd-control', combo: 'next-layout', enabled: false }),
  ];
}
function defaultGestureSettings() {
  return {
    enabled: true,
    edgeMarginPx: 28,     // a contact must START within this many px of the L/R screen edge
    minSwipePx: 110,      // min centroid travel to count as a swipe/path
    tapMaxPx: 30,         // max centroid movement still considered a tap
    tapMaxMs: 320,        // max duration for a tap
    rotateMinDeg: 35,     // min orbit angle for a rotate
    pinchMinRatio: 0.72,  // mean-radius end/start <= this => pinch IN (>= 1/ratio => OUT)
    pathMinScore: 0.80,   // $P recognizer confidence floor (0..1)
    cooldownMs: 350,      // ignore re-triggers within this window
    captureMultiFinger: false, // claim 3+ finger touch so it doesn't also reach other apps
  };
}

function defaultConfig() {
  return {
    overlay: { x: null, y: null, radius: 120, buttonSize: 54, collapsed: false },
    activeLayout: 0,
    gestures: defaultGlobalGestures(),
    gestureSettings: defaultGestureSettings(),
    layouts: [
      {
        name: 'General', color: '#5b8cff', mode: 'radial',
        items: [
          key('Copy', 'ctrl+c', 'press', '#5b8cff'),
          key('Paste', 'ctrl+v', 'press', '#5b8cff'),
          key('Cut', 'ctrl+x', 'press', '#5b8cff'),
          key('Undo', 'ctrl+z', 'press', '#46c08f'),
          key('Redo', 'ctrl+y', 'press', '#46c08f'),
          key('Save', 'ctrl+s', 'press', '#f2b53b'),
          key('Find', 'ctrl+f', 'press', '#9b6cff'),
          key('All', 'ctrl+a', 'press', '#9b6cff'),
          key('Gestures', '', 'gesture-toggle', '#9b6cff'),
        ],
      },
      {
        name: 'Numpad', color: '#46c08f', mode: 'grid',
        cell: 60, gap: 8, cols: 5, rows: 4,
        items: [
          key('7', '7', 'press', '#3a3f4c', 0, 0), key('8', '8', 'press', '#3a3f4c', 1, 0), key('9', '9', 'press', '#3a3f4c', 2, 0),
          key('4', '4', 'press', '#3a3f4c', 0, 1), key('5', '5', 'press', '#3a3f4c', 1, 1), key('6', '6', 'press', '#3a3f4c', 2, 1),
          key('1', '1', 'press', '#3a3f4c', 0, 2), key('2', '2', 'press', '#3a3f4c', 1, 2), key('3', '3', 'press', '#3a3f4c', 2, 2),
          key('0', '0', 'press', '#3a3f4c', 0, 3, 2, 1), key('.', '.', 'press', '#3a3f4c', 2, 3),
          key('Enter', 'enter', 'press', '#5b8cff', 3, 0, 1, 2),
          key('Bksp', 'backspace', 'press', '#c05b5b', 3, 2),
          group('fn', '#9b6cff', 3, 3, 1, 1, [
            key('F1', 'f1', 'press', '#9b6cff', 0, 0), key('F2', 'f2', 'press', '#9b6cff', 1, 0),
            key('F3', 'f3', 'press', '#9b6cff', 0, 1), key('F4', 'f4', 'press', '#9b6cff', 1, 1),
          ]),
          scroll('Scroll', '#46c08f', 4, 0, 1, 4, 'v'),
        ],
      },
      {
        name: 'Trackpad', color: '#e0726b', mode: 'grid',
        cell: 64, gap: 8, cols: 4, rows: 6,
        items: [
          touchpad('Trackpad', '#e0726b', 0, 0, 4, 4, false),
          mousebtn('Left', 'l', '#5b8cff', 0, 4, 2, 1),
          mousebtn('Right', 'r', '#5b8cff', 2, 4, 2, 1),
          mousebtn('Middle', 'm', '#46c08f', 0, 5, 2, 1),
          mousebtn('Double', 'l', '#9b6cff', 2, 5, 2, 1, 2),
        ],
      },
      {
        name: 'Photoshop', color: '#f2b53b', mode: 'radial',
        items: [
          key('Brush', 'b', 'press', '#46c08f'),
          key('Eraser', 'e', 'press', '#46c08f'),
          key('Eyedrop', 'i', 'press', '#46c08f'),
          key('Move', 'v', 'press', '#46c08f'),
          key('Hand', 'space', 'hold', '#f2b53b'),
          key('Undo', 'ctrl+z', 'press', '#5b8cff'),
          key('Deselect', 'ctrl+d', 'press', '#5b8cff'),
          key('Flip', 'ctrl+shift+x', 'press', '#9b6cff'),
        ],
      },
    ],
  };
}

// migrate older { keys:[...] } shape -> { mode:'radial', items:[...] }
function migrate(cfg) {
  if (!cfg || !cfg.layouts) return defaultConfig();
  for (const l of cfg.layouts) {
    if (!l.mode) l.mode = 'radial';
    if (!l.items && l.keys) { l.items = l.keys; delete l.keys; }
    if (!l.items) l.items = [];
    walk(l.items, (it) => {
      if (!it.id) it.id = uid();
      if (!it.type) it.type = 'key';
      if (it.type === 'group' && !it.items) it.items = [];
      if (it.type === 'touchpad') {
        if (!Array.isArray(it.gestures)) it.gestures = defaultGestures();
        if (it.sensitivity == null) it.sensitivity = 1.2;
        if (it.scrollSpeed == null) it.scrollSpeed = 1;
        if (it.naturalScroll == null) it.naturalScroll = false;
        if (it.expand == null) it.expand = false;
      }
      if (it.type === 'mousebtn') { if (!it.button) it.button = 'l'; if (!it.clicks) it.clicks = 1; if (!it.mode) it.mode = 'click'; }
      // existing keys keep their curated labels (Copy, Paste…): don't auto-rename them
      if (it.type === 'key' && it.autoLabel === undefined) it.autoLabel = false;
    });
    if (l.mode === 'grid') { l.cell = l.cell || 60; l.gap = l.gap || 8; l.cols = l.cols || 5; l.rows = l.rows || 4; }
  }
  if (!cfg.overlay) cfg.overlay = {};
  if (cfg.overlay.collapsed == null) cfg.overlay.collapsed = false;
  // global gestures (added later): seed defaults once, fill any missing settings keys
  if (!Array.isArray(cfg.gestures)) cfg.gestures = defaultGlobalGestures();
  cfg.gestureSettings = Object.assign(defaultGestureSettings(), cfg.gestureSettings || {});
  for (const g of cfg.gestures) {
    if (!g.id) g.id = 'g' + Math.random().toString(36).slice(2, 9);
    if (g.enabled == null) g.enabled = true;
    if (!g.action) g.action = 'press';
  }
  // one-time: drop a "Gestures on/off" toggle button into an existing config that predates it,
  // so current users get the new control without recreating their layouts.
  if (!cfg._gtSeeded) {
    if (!cfg.layouts.some((l) => hasGestureToggle(l.items))) {
      const target = cfg.layouts.find((l) => l.mode !== 'grid') || cfg.layouts[0];
      if (target) { if (!Array.isArray(target.items)) target.items = []; target.items.push(key('Gestures', '', 'gesture-toggle', '#9b6cff')); }
    }
    cfg._gtSeeded = true;
  }
  return cfg;
}
function hasGestureToggle(items) {
  if (!Array.isArray(items)) return false;
  for (const it of items) { if (it.action === 'gesture-toggle') return true; if (it.items && hasGestureToggle(it.items)) return true; }
  return false;
}
function walk(items, fn) { for (const it of items) { fn(it); if (it.items) walk(it.items, fn); } }

function backupPath() { return configPath() + '.bak'; }
function isValid(cfg) { return !!(cfg && Array.isArray(cfg.layouts) && cfg.layouts.length); }

// Read + parse a config file, retrying a few times for transient locks. A freshly-booted
// box (or cloud-synced AppData) can have config.json momentarily locked by AV / the sync
// client; a single failed read used to silently fall back to defaults and the next save
// then ERASED the user's real layouts. Distinguish "couldn't read" from "isn't there".
function tryRead(file) {
  for (let i = 0; i < 5; i++) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (e) {
      if (e && e.code === 'ENOENT') return { state: 'missing' };   // genuinely absent
      // EBUSY / EACCES / EPERM: exists but locked -> wait briefly and retry
      const until = Date.now() + 60; while (Date.now() < until) {}  // ~60ms spin (sync context)
      continue;
    }
    try {
      const cfg = JSON.parse(raw);
      if (isValid(cfg)) return { state: 'ok', cfg };
      return { state: 'corrupt' };                                   // parsed but empty/garbage
    } catch { return { state: 'corrupt' }; }                         // unparseable
  }
  return { state: 'locked' };                                        // exists but never readable
}

// One-time seed import. A seed file shipped next to app.asar (resources/seed-config.json)
// can carry layouts that must be restored into the user's REAL config — e.g. recovering a
// layout that an earlier load-failure footgun wiped. This runs inside the app, which (unlike
// external/elevated tooling) writes the genuine per-user config, so it lands where the app
// actually reads. Idempotent: a `seedTag` recorded in the config means "this seed already
// applied" so it never re-adds (and never resurrects a layout the user deliberately deleted).
function applySeed(cfg) {
  try {
    const base = process.resourcesPath || '';
    const sp = path.join(base, 'seed-config.json');
    if (!fs.existsSync(sp)) return cfg;
    const seed = JSON.parse(fs.readFileSync(sp, 'utf8'));
    if (!seed || !seed.tag || !Array.isArray(seed.layouts)) return cfg;
    if (cfg.seedTag === seed.tag) return cfg;            // already applied
    const have = new Set((cfg.layouts || []).map((l) => l && l.name));
    let added = 0;
    for (const l of seed.layouts) { if (l && l.name && !have.has(l.name)) { cfg.layouts.push(l); added++; } }
    cfg.seedTag = seed.tag;
    cfg = migrate(cfg);
    save(cfg);                                            // persist into the real per-user config
    return cfg;
  } catch { return cfg; }
}

function load() {
  const main = tryRead(configPath());
  if (main.state === 'ok') return applySeed(migrate(main.cfg));

  // Primary unusable. Try the rotating backup before EVER falling back to defaults — a
  // corrupt/locked primary must not cost the user their layouts.
  const bak = tryRead(backupPath());
  if (bak.state === 'ok') {
    // Restore the good backup over the bad primary so the next save has a sane base.
    try { fs.copyFileSync(backupPath(), configPath()); } catch {}
    return applySeed(migrate(bak.cfg));
  }

  // Only a TRUE first run (both missing) gets defaults. If the primary exists but is
  // merely locked/corrupt with no usable backup, still return defaults so the app can
  // run — but save() preserves the existing file to .bak before overwriting, so nothing
  // is lost irrecoverably.
  return applySeed(defaultConfig());
}

function save(cfg) {
  if (!isValid(cfg)) return false;            // never persist an empty/garbage config
  try {
    const file = configPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Preserve the current good config as the backup BEFORE overwriting. Only rotate when
    // the existing file is itself valid, so a single bad/defaults save can't poison the bak.
    const cur = tryRead(file);
    if (cur.state === 'ok') { try { fs.copyFileSync(file, backupPath()); } catch {} }
    // Atomic write: temp file -> fsync -> rename. A crash/power-loss mid-write (e.g. the PC
    // restart that started all this) then can't leave a truncated config.json.
    const tmp = file + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, JSON.stringify(cfg, null, 2), null, 'utf8'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}

module.exports = { load, save, defaultConfig, configPath, uid };
