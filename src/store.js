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
    gx: gx || 0, gy: gy || 0, gw: gw || 1, gh: gh || 1, clicks: clicks || 1 };
}

function defaultConfig() {
  return {
    overlay: { x: null, y: null, radius: 120, buttonSize: 54, collapsed: false },
    activeLayout: 0,
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
      if (it.type === 'mousebtn') { if (!it.button) it.button = 'l'; if (!it.clicks) it.clicks = 1; }
      // existing keys keep their curated labels (Copy, Paste…): don't auto-rename them
      if (it.type === 'key' && it.autoLabel === undefined) it.autoLabel = false;
    });
    if (l.mode === 'grid') { l.cell = l.cell || 60; l.gap = l.gap || 8; l.cols = l.cols || 5; l.rows = l.rows || 4; }
  }
  if (!cfg.overlay) cfg.overlay = {};
  if (cfg.overlay.collapsed == null) cfg.overlay.collapsed = false;
  return cfg;
}
function walk(items, fn) { for (const it of items) { fn(it); if (it.items) walk(it.items, fn); } }

function load() {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    if (!cfg.layouts || !cfg.layouts.length) return defaultConfig();
    return migrate(cfg);
  } catch { return defaultConfig(); }
}
function save(cfg) {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8');
    return true;
  } catch { return false; }
}

module.exports = { load, save, defaultConfig, configPath, uid };
