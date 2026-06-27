'use strict';
let cfg = null;
let sel = 0;            // selected layout index
let navStack = [];      // group ids drilled into within current layout
let selId = null;       // selected item id within current level
let saveTimer = null;

// undo/redo history (snapshots of cfg as JSON strings)
let undoStack = [], redoStack = [], baseline = null;

const $ = (id) => document.getElementById(id);
function uid() { return 'k' + Math.random().toString(36).slice(2, 9); }
function L() { return cfg.layouts[sel]; }

// ---------- save ----------
function markDirty() {
  $('saveState').textContent = 'saving…';
  $('saveState').classList.add('dirty');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    commitHistory();
    window.rd.saveConfig(cfg);
    $('saveState').textContent = 'saved';
    $('saveState').classList.remove('dirty');
  }, 220);
}

// ---------- undo / redo ----------
function commitHistory() {
  const cur = JSON.stringify(cfg);
  if (baseline === null || cur === baseline) { baseline = cur; return; }
  undoStack.push(baseline);
  if (undoStack.length > 100) undoStack.shift();
  redoStack = [];
  baseline = cur;
  updateUndoButtons();
}
function applyState(json) {
  cfg = JSON.parse(json);
  baseline = json;
  if (sel >= cfg.layouts.length) sel = Math.max(0, cfg.layouts.length - 1);
  validateNav();
  window.rd.saveConfig(cfg);
  renderAll();
  updateUndoButtons();
  $('saveState').textContent = 'saved';
  $('saveState').classList.remove('dirty');
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(JSON.stringify(cfg));
  applyState(undoStack.pop());
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(JSON.stringify(cfg));
  applyState(redoStack.pop());
}
function updateUndoButtons() {
  $('btnUndo').disabled = undoStack.length === 0;
  $('btnRedo').disabled = redoStack.length === 0;
}
// drop nav/selection that no longer exists after a state swap
function validateNav() {
  let items = (cfg.layouts[sel] || {}).items || [];
  const valid = [];
  for (const id of navStack) {
    const g = items.find((it) => it.id === id && it.type === 'group');
    if (!g) break;
    valid.push(id); items = g.items;
  }
  navStack = valid;
  if (selId && !curLevel().items.some((it) => it.id === selId)) selId = null;
}
$('btnUndo').addEventListener('click', undo);
$('btnRedo').addEventListener('click', redo);
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const t = e.target;
  if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return; // let fields keep native text undo
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
});

// ---------- drill-level resolution ----------
function curLevel() {
  let items = L().items, group = null;
  for (const id of navStack) {
    const g = (items || []).find((it) => it.id === id && it.type === 'group');
    if (!g) { navStack = []; return { items: L().items, group: null }; }
    group = g; items = g.items;
  }
  return { items, group };
}
const isGridLevel = () => navStack.length > 0 || L().mode === 'grid';
// Items can be sized/placed on a sub-cell grid (quarter-cell granularity), so a button can be
// smaller than one full cell. Spans round UP to whole cells when sizing the grid that holds them.
const SUB = 4, MINSZ = 0.5;                       // snap unit = 1/SUB of a cell; smallest item = half a cell
const snap = (v) => Math.round(v * SUB) / SUB;
const spanCols = (items) => Math.ceil(Math.max(1, ...items.map((i) => (i.gx || 0) + (i.gw || 1))));
const spanRows = (items) => Math.ceil(Math.max(1, ...items.map((i) => (i.gy || 0) + (i.gh || 1))));

// ---------- auto-label from combo ----------
// A key's label can auto-track its combo (e.g. "ctrl+shift+s" -> "Ctrl+Shift+S").
// it.autoLabel === true keeps it in sync; typing a manual label turns it off, and
// clearing the label turns it back on.
const COMBO_NAMES = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', win: 'Win', esc: 'Esc', enter: 'Enter',
  tab: 'Tab', backspace: '⌫', space: 'Space', delete: 'Del', insert: 'Ins', home: 'Home', end: 'End',
  pageup: 'PgUp', pagedown: 'PgDn', up: '↑', down: '↓', left: '←', right: '→', capslock: 'Caps',
  numadd: 'Num+', numsub: 'Num-', nummult: 'Num*', numdiv: 'Num/', numdec: 'Num.' };
function prettyCombo(combo) {
  if (!combo) return '';
  return String(combo).split('+').map((t) => {
    t = t.trim(); if (!t) return '';
    if (COMBO_NAMES[t]) return COMBO_NAMES[t];
    if (/^f\d+$/.test(t)) return t.toUpperCase();              // f1 -> F1
    if (/^num\d$/.test(t)) return 'Num' + t.slice(3);          // num7 -> Num7
    if (t.length === 1) return t.toUpperCase();                // c -> C, / -> /
    return t.charAt(0).toUpperCase() + t.slice(1);             // word -> Word
  }).join('+');
}
// push a new combo onto a key, renaming the label too if it's in auto mode
function setKeyCombo(it, combo) {
  it.combo = combo;
  if (it.autoLabel !== false) {
    it.label = prettyCombo(combo);
    const li = $('pLabel'); if (li) li.value = it.label;
  }
}
// assign an icon (built-in 'lc:<id>' or a 'data:' image URL) and seed its fit/size
function setIcon(it, icon) {
  it.icon = icon;
  if (it.iconFit == null) it.iconFit = 'fit';
  if (it.iconSize == null) it.iconSize = 100;
  renderProps(); refreshItemVisual(); markDirty();
}

function gridDims() {
  const { items } = curLevel();
  if (navStack.length) return { cols: Math.max(spanCols(items) + 1, 3), rows: Math.max(spanRows(items) + 1, 3) };
  return { cols: L().cols || 5, rows: L().rows || 4 };
}
function findItem(id) { return curLevel().items.find((it) => it.id === id) || null; }

// ---------- layouts sidebar ----------
function renderLayouts() {
  const list = $('layoutList');
  list.innerHTML = '';
  cfg.layouts.forEach((lay, i) => {
    const li = document.createElement('li');
    if (i === sel) li.classList.add('sel');
    li.innerHTML =
      `<span class="swatch" style="background:${lay.color || '#5b8cff'}"></span>` +
      `<span class="lname">${escapeHtml(lay.name || 'Untitled')}</span>` +
      `<span class="mtag">${lay.mode === 'grid' ? 'grid' : 'rad'}</span>` +
      `<span class="del" title="Delete layout">🗑</span>`;
    li.addEventListener('click', (e) => {
      if (e.target.classList.contains('del')) return;
      sel = i; navStack = []; selId = null; renderAll();
    });
    li.querySelector('.del').addEventListener('click', (e) => { e.stopPropagation(); deleteLayout(i); });
    list.appendChild(li);
  });
}
function deleteLayout(i) {
  if (cfg.layouts.length <= 1) { alert('Keep at least one layout.'); return; }
  if (!confirm(`Delete layout "${cfg.layouts[i].name}"?`)) return;
  cfg.layouts.splice(i, 1);
  if (sel >= cfg.layouts.length) sel = cfg.layouts.length - 1;
  navStack = []; selId = null; renderAll(); markDirty();
}
$('addLayout').addEventListener('click', () => {
  cfg.layouts.push({ name: 'New Layout', color: '#5b8cff', mode: 'radial', items: [
    mkKey('Save', 'ctrl+s', 'press', '#5b8cff'),
  ] });
  sel = cfg.layouts.length - 1; navStack = []; selId = null;
  renderAll(); markDirty();
});

// ---------- item factories ----------
function mkKey(label, combo, action, color, gx, gy) {
  return { id: uid(), type: 'key', label: label || '', combo: combo || '', action: action || 'press',
    autoLabel: true, color: color || '#3a3f4c', gx: gx || 0, gy: gy || 0, gw: 1, gh: 1 };
}
function mkGroup(gx, gy) {
  return { id: uid(), type: 'group', label: 'Group', color: '#9b6cff', gx: gx || 0, gy: gy || 0, gw: 1, gh: 1, items: [] };
}
function mkScroll(gx, gy) {
  return { id: uid(), type: 'scroll', label: 'Scroll', color: '#46c08f', gx: gx || 0, gy: gy || 0, gw: 1, gh: 2, axis: 'v', step: 1, invert: false };
}
function defaultGestures() {
  return [
    { fingers: 3, dir: 'left', action: 'press', combo: 'alt+left' },
    { fingers: 3, dir: 'right', action: 'press', combo: 'alt+right' },
    { fingers: 3, dir: 'up', action: 'press', combo: 'win+tab' },
    { fingers: 3, dir: 'down', action: 'press', combo: 'win+d' },
  ];
}
function mkTouchpad(gx, gy) {
  return { id: uid(), type: 'touchpad', label: 'Trackpad', color: '#e0726b', gx: gx || 0, gy: gy || 0, gw: 3, gh: 3,
    expand: false, sensitivity: 1.2, accel: 0, scrollSpeed: 1, scrollAccel: 0, naturalScroll: false, gestures: defaultGestures() };
}
function mkMousebtn(gx, gy) {
  return { id: uid(), type: 'mousebtn', label: 'Click', button: 'l', color: '#5b8cff', gx: gx || 0, gy: gy || 0, gw: 1, gh: 1, clicks: 1 };
}

// ---------- layout settings bar ----------
function renderBar() {
  $('layName').value = L().name || '';
  $('layColor').value = L().color || '#5b8cff';
  const mode = L().mode || 'radial';
  [...$('modeSeg').children].forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  // mode/grid options only edit the layout root; inside a group they're hidden
  const inGroup = navStack.length > 0;
  $('modeSeg').classList.toggle('hidden', inGroup);
  const showGrid = mode === 'grid' && !inGroup;
  $('gridOpts').classList.toggle('hidden', !showGrid);
  if (showGrid) {
    $('optCell').value = L().cell || 60; $('optGap').value = L().gap || 8;
    $('optCols').value = L().cols || 5; $('optRows').value = L().rows || 4;
  }
}
$('layName').addEventListener('input', (e) => { L().name = e.target.value; renderLayouts(); renderBreadcrumb(); renderCanvas(); markDirty(); });
$('layColor').addEventListener('input', (e) => { L().color = e.target.value; renderLayouts(); renderCanvas(); markDirty(); });
[...$('modeSeg').children].forEach((b) => b.addEventListener('click', () => {
  const m = b.dataset.mode;
  if (L().mode === m) return;
  L().mode = m;
  if (m === 'grid') { L().cell = L().cell || 60; L().gap = L().gap || 8; L().cols = L().cols || 5; L().rows = L().rows || 4; }
  selId = null; renderAll(); markDirty();
}));
['optCell', 'optGap', 'optCols', 'optRows'].forEach((id) => $(id).addEventListener('input', (e) => {
  const key = { optCell: 'cell', optGap: 'gap', optCols: 'cols', optRows: 'rows' }[id];
  L()[key] = Math.max(id === 'optGap' ? 0 : 1, +e.target.value || 0);
  renderCanvas(); markDirty();
}));

// ---------- breadcrumb ----------
function renderBreadcrumb() {
  const bc = $('breadcrumb');
  bc.innerHTML = '';
  const crumbs = [{ label: L().name || 'Layout', depth: 0 }];
  let items = L().items;
  navStack.forEach((id, idx) => {
    const g = (items || []).find((it) => it.id === id);
    crumbs.push({ label: g ? (g.label || 'Group') : 'Group', depth: idx + 1 });
    items = g ? g.items : [];
  });
  crumbs.forEach((c, i) => {
    if (i) { const s = document.createElement('span'); s.className = 'sep'; s.textContent = '›'; bc.appendChild(s); }
    const el = document.createElement('span');
    el.className = 'crumb' + (i === crumbs.length - 1 ? ' here' : '');
    el.textContent = c.label;
    if (i !== crumbs.length - 1) el.addEventListener('click', () => { navStack = navStack.slice(0, c.depth); selId = null; renderCanvasAndBar(); });
    bc.appendChild(el);
  });
}

// ---------- add bar ----------
function renderAddBar() {
  const bar = $('addBar');
  bar.innerHTML = '';
  const add = (label, fn, cls) => { const b = document.createElement('button'); b.className = cls || 'ghost'; b.textContent = label; b.addEventListener('click', fn); bar.appendChild(b); };
  if (isGridLevel()) {
    add('＋ Key', () => addItem(mkKey), 'primary');
    add('＋ Group', () => addItem(mkGroup));
    add('＋ Scroll', () => addItem(mkScroll));
    add('＋ Touchpad', () => addItem(mkTouchpad));
    add('＋ Mouse', () => addItem(mkMousebtn));
  } else {
    add('＋ Add key', () => { L().items.push(mkKey('', '', 'press', L().color)); selId = L().items[L().items.length - 1].id; renderCanvas(); renderProps(); markDirty(); }, 'primary');
  }
}
function findFreeCell() {
  const { items } = curLevel();
  const { cols, rows } = gridDims();
  const taken = (x, y) => items.some((it) => x >= (it.gx || 0) && x < (it.gx || 0) + (it.gw || 1) && y >= (it.gy || 0) && y < (it.gy || 0) + (it.gh || 1));
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (!taken(x, y)) return { gx: x, gy: y };
  return { gx: 0, gy: 0 };
}
function addItem(factory) {
  const { gx, gy } = findFreeCell();
  const it = factory(gx, gy);
  curLevel().items.push(it);
  selId = it.id;
  renderCanvas(); renderProps(); markDirty();
}

// ---------- canvas ----------
function renderCanvas() {
  const grid = isGridLevel();
  $('radialView').classList.toggle('hidden', grid);
  $('gridScroll').classList.toggle('hidden', !grid);
  if (grid) renderGrid(); else renderRadial();
}
function renderCanvasAndBar() { renderBar(); renderBreadcrumb(); renderAddBar(); renderCanvas(); renderProps(); }

function renderRadial() {
  const lay = L();
  const orb = $('previewOrb'), ring = $('previewRing');
  orb.textContent = (lay.name || '?').trim().charAt(0).toUpperCase();
  orb.style.background = `radial-gradient(circle at 35% 30%, ${shade(lay.color, 30)}, ${lay.color} 70%, ${shade(lay.color, -40)})`;
  ring.innerHTML = '';
  const items = lay.items, n = items.length;
  const R = cfg.overlay.radius || 120, bs = cfg.overlay.buttonSize || 54;
  items.forEach((k, i) => {
    const ang = -Math.PI / 2 + (i / n) * Math.PI * 2;
    const el = document.createElement('div');
    el.className = 'pkey' + (k.id === selId ? ' sel' : '');
    el.style.left = (50 + (R / 160) * 50 * Math.cos(ang)) + '%';
    el.style.top = (50 + (R / 160) * 50 * Math.sin(ang)) + '%';
    el.style.width = bs + 'px'; el.style.height = bs + 'px';
    el.style.background = `linear-gradient(160deg, ${shade(k.color, 18)}, ${k.color})`;
    const ico = RDIcons.html(k);
    if (ico) el.innerHTML = ico; else el.textContent = k.label || k.combo || '';
    el.addEventListener('click', () => { selId = k.id; renderRadial(); renderProps(); });
    ring.appendChild(el);
  });
}

function renderGrid() {
  const { items } = curLevel();
  const cell = L().cell || 60, gap = L().gap || 8, step = cell + gap;
  const { cols, rows } = gridDims();
  const gv = $('gridView');
  gv.style.setProperty('--step', step + 'px');
  gv.style.width = (cols * cell + (cols - 1) * gap + gap) + 'px';
  gv.style.height = (rows * cell + (rows - 1) * gap + gap) + 'px';
  gv.style.backgroundPosition = `${gap / 2}px ${gap / 2}px`;
  gv.innerHTML = '';
  items.forEach((it) => gv.appendChild(gridItem(it, cell, gap, step, cols, rows)));
  // click empty area clears selection
  gv.onpointerdown = (e) => { if (e.target === gv) { selId = null; renderGrid(); renderProps(); } };
}

function gridItem(it, cell, gap, step, cols, rows) {
  const el = document.createElement('div');
  const typeCls = it.type === 'scroll' ? ' scroll' : it.type === 'touchpad' ? ' pad' : it.type === 'mousebtn' ? ' mbtn' : '';
  el.className = 'gi' + typeCls + (it.id === selId ? ' sel' : '');
  place(el, it, cell, gap, step);
  el.style.background = `linear-gradient(160deg, ${shade(it.color, 18)}, ${it.color})`;
  const ico = RDIcons.html(it);
  let inner = ico || `<span>${escapeHtml(it.label || it.combo || '')}</span>`;
  if (it.type === 'group') inner += `<span class="folder">▸</span>`;
  if (it.type === 'scroll') inner += `<span class="tag">${it.axis === 'h' ? 'H' : 'V'}</span>`;
  if (it.type === 'touchpad') inner += `<span class="tag">${it.expand ? 'PAD▸' : 'PAD'}</span>`;
  if (it.type === 'mousebtn') inner += `<span class="tag">${({ l: 'L', r: 'R', m: 'M' }[it.button] || 'L')}${it.mode === 'hold' ? '↓' : ((it.clicks || 1) > 1 ? '×' + it.clicks : '')}</span>`;
  if (it.type === 'key' && it.action && it.action !== 'press') inner += `<span class="tag">${it.action.slice(0, 3).toUpperCase()}</span>`;
  inner += `<span class="rsz"></span>`;
  el.innerHTML = inner;

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.classList.contains('rsz')) { startResize(e, it, el, cell, gap, step, cols, rows); return; }
    startMove(e, it, el, cell, gap, step, cols, rows);
  });
  if (it.type === 'group') el.addEventListener('dblclick', () => { navStack.push(it.id); selId = null; renderCanvasAndBar(); });
  return el;
}
function place(el, it, cell, gap, step) {
  el.style.left = (gap / 2 + (it.gx || 0) * step) + 'px';
  el.style.top = (gap / 2 + (it.gy || 0) * step) + 'px';
  el.style.width = ((it.gw || 1) * step - gap) + 'px';
  el.style.height = ((it.gh || 1) * step - gap) + 'px';
}

function startMove(e, it, el, cell, gap, step, cols, rows) {
  if (e.button > 0) return; // allow touch/pen (0) + left mouse; ignore right/middle
  e.preventDefault();
  selId = it.id; markSel(); renderProps();
  el.classList.add('dragging');
  const s = { x: e.clientX, y: e.clientY, gx: it.gx || 0, gy: it.gy || 0, moved: false };
  try { el.setPointerCapture(e.pointerId); } catch {}
  const mv = (ev) => {
    const dx = ev.clientX - s.x, dy = ev.clientY - s.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) s.moved = true;
    let gx = clamp(snap(s.gx + dx / step), 0, cols - (it.gw || 1));
    let gy = clamp(snap(s.gy + dy / step), 0, rows - (it.gh || 1));
    it.gx = gx; it.gy = gy; place(el, it, cell, gap, step);
  };
  const up = () => {
    el.classList.remove('dragging');
    try { el.releasePointerCapture(e.pointerId); } catch {}
    el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
    if (s.moved) { renderProps(); markDirty(); }
  };
  el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
}
function startResize(e, it, el, cell, gap, step, cols, rows) {
  if (e.button > 0) return;
  e.preventDefault(); e.stopPropagation();
  selId = it.id; markSel(); renderProps();
  el.classList.add('dragging');
  const s = { x: e.clientX, y: e.clientY, gw: it.gw || 1, gh: it.gh || 1, changed: false };
  try { el.setPointerCapture(e.pointerId); } catch {}
  const mv = (ev) => {
    const dx = ev.clientX - s.x, dy = ev.clientY - s.y;
    const gw = clamp(snap(s.gw + dx / step), MINSZ, cols - (it.gx || 0));
    const gh = clamp(snap(s.gh + dy / step), MINSZ, rows - (it.gy || 0));
    if (gw !== it.gw || gh !== it.gh) s.changed = true;
    it.gw = gw; it.gh = gh;
    place(el, it, cell, gap, step);
  };
  const up = () => {
    el.classList.remove('dragging');
    try { el.releasePointerCapture(e.pointerId); } catch {}
    el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
    if (s.changed) { renderProps(); markDirty(); }
  };
  el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
}
function markSel() {
  document.querySelectorAll('#gridView .gi').forEach((n) => n.classList.remove('sel'));
  const cur = [...document.querySelectorAll('#gridView .gi')];
  const idx = curLevel().items.findIndex((it) => it.id === selId);
  if (idx >= 0 && cur[idx]) cur[idx].classList.add('sel');
}

// ---------- properties panel ----------
function renderProps() {
  const p = $('props');
  const it = findItem(selId);
  if (!it) { p.innerHTML = '<div class="props-empty">Select an item to edit it.</div>'; return; }
  const grid = isGridLevel();
  let h = `<div class="props"><h4>${it.type}</h4>`;
  h += row('Label', `<input type="text" id="pLabel" value="${escapeAttr(it.label)}" />`);
  if (it.type === 'key') {
    const cmdPh = it.action === 'command' ? 'shell command, e.g. notepad' : 'e.g. ctrl+shift+s';
    h += row('Combo / Command', `<div class="combo-wrap"><input type="text" id="pCombo" placeholder="${cmdPh}" value="${escapeAttr(it.combo)}" /><button class="cap" id="pRec">REC</button></div>`);
    h += row('Action', `<select id="pAction">
      <option value="press">Press</option><option value="hold">Hold</option>
      <option value="toggle">Toggle</option><option value="command">Command</option>
      <option value="gesture-toggle">Gestures on/off</option></select>`);
  }
  if (it.type === 'scroll') {
    h += row('Axis', `<select id="pAxis"><option value="v">Vertical</option><option value="h">Horizontal</option></select>`);
    h += row('Step (speed)', `<input type="number" id="pStep" min="1" max="10" value="${it.step || 1}" />`);
    h += `<div class="prow check"><input type="checkbox" id="pInvert" ${it.invert ? 'checked' : ''} /><label for="pInvert">Invert direction</label></div>`;
  }
  if (it.type === 'mousebtn') {
    h += row('Button', `<select id="pButton"><option value="l">Left</option><option value="r">Right</option><option value="m">Middle</option></select>`);
    h += row('Mode', `<select id="pMode"><option value="click">Click</option><option value="hold">Hold (press &amp; release)</option></select>`);
    if ((it.mode || 'click') !== 'hold') h += row('Clicks', `<input type="number" id="pClicks" min="1" max="3" value="${it.clicks || 1}" />`);
  }
  if (it.type === 'touchpad') {
    h += `<div class="prow check"><input type="checkbox" id="pExpand" ${it.expand ? 'checked' : ''} /><label for="pExpand">Expand to full pad (drill-in)</label></div>`;
    h += row('Pointer speed', `<input type="number" id="pSens" min="0.2" max="4" step="0.1" value="${it.sensitivity != null ? it.sensitivity : 1.2}" />`);
    h += row('Acceleration', `<input type="number" id="pAccel" min="0" max="3" step="0.1" value="${it.accel != null ? it.accel : 0}" />`);
    h += row('Scroll speed', `<input type="number" id="pScrollSpd" min="0.2" max="5" step="0.1" value="${it.scrollSpeed != null ? it.scrollSpeed : 1}" />`);
    h += row('Scroll accel', `<input type="number" id="pScrollAccel" min="0" max="3" step="0.1" value="${it.scrollAccel != null ? it.scrollAccel : 0}" />`);
    h += `<div class="prow check"><input type="checkbox" id="pNatural" ${it.naturalScroll ? 'checked' : ''} /><label for="pNatural">Natural scroll</label></div>`;
    h += gesturesHtml(it);
  }
  h += row('Color', `<input type="color" id="pColor" value="${it.color || '#3a3f4c'}" />`);
  const canIcon = it.type === 'key' || it.type === 'mousebtn' || it.type === 'group';
  if (canIcon) {
    h += `<div class="prow"><label>Icon</label>
      <div class="icon-ctl">
        <div class="icon-prev" id="pIconPrev">${RDIcons.html(it) || '<span class="ip-none">—</span>'}</div>
        <button class="ghost btn-sm" id="pIconPick" title="Choose a built-in icon">Icons ▾</button>
        <button class="ghost btn-sm" id="pIconImg" title="Use a custom image">Image…</button>
        <button class="ghost btn-sm" id="pIconClr" title="Remove icon">✕</button>
      </div></div>`;
    h += `<div id="pIconGrid" class="icon-grid hidden"></div>`;
    if (it.icon) {
      h += `<div class="prow inline">
        <div><label>Fit</label><select id="pIconFit">
          <option value="fit">Fit</option><option value="fill">Fill</option>
          <option value="stretch">Stretch</option><option value="pad">Padded</option></select></div>
        <div><label>Size <span id="pIconSizeV">${it.iconSize || 100}</span>%</label>
          <input type="range" id="pIconSize" min="25" max="200" step="5" value="${it.iconSize || 100}" /></div>
      </div>`;
    }
  }
  if (grid) {
    h += `<div class="prow inline"><div><label>X</label><input type="number" id="pGx" min="0" step="0.25" value="${it.gx || 0}" /></div>
      <div><label>Y</label><input type="number" id="pGy" min="0" step="0.25" value="${it.gy || 0}" /></div>
      <div><label>W</label><input type="number" id="pGw" min="0.5" step="0.25" value="${it.gw || 1}" /></div>
      <div><label>H</label><input type="number" id="pGh" min="0.5" step="0.25" value="${it.gh || 1}" /></div></div>`;
  }
  h += '<div class="btnrow">';
  if (it.type === 'group') h += `<button class="ghost" id="pOpen">Open ▸</button>`;
  if (!grid) h += `<button class="ghost" id="pLeft">◄</button><button class="ghost" id="pRight">►</button>`;
  h += `<button class="danger" id="pDel">Delete</button></div></div>`;
  p.innerHTML = h;

  if (it.type === 'key') $('pAction').value = it.action || 'press';
  if (it.type === 'scroll') $('pAxis').value = it.axis || 'v';
  if (it.type === 'mousebtn') { $('pButton').value = it.button || 'l'; $('pMode').value = it.mode || 'click'; }

  bindP('pLabel', 'input', (v) => { it.label = v; if (it.type === 'key') it.autoLabel = (v.trim() === ''); refreshItemVisual(); });
  if (it.type === 'key') {
    // typing/recording a combo auto-renames the label while it.autoLabel is on
    bindP('pCombo', 'input', (v) => { setKeyCombo(it, v); refreshItemVisual(); });
    bindP('pAction', 'change', (v) => { it.action = v; renderProps(); refreshItemVisual(); });
    $('pRec').addEventListener('click', () => captureCombo((c) => { setKeyCombo(it, c); $('pCombo').value = c; refreshItemVisual(); markDirty(); }));
  }
  if (it.type === 'scroll') {
    bindP('pAxis', 'change', (v) => { it.axis = v; refreshItemVisual(); });
    bindP('pStep', 'input', (v) => { it.step = clamp(+v || 1, 1, 10); });
    $('pInvert').addEventListener('change', (e) => { it.invert = e.target.checked; markDirty(); });
  }
  if (it.type === 'mousebtn') {
    bindP('pButton', 'change', (v) => { it.button = v; refreshItemVisual(); });
    bindP('pMode', 'change', (v) => { it.mode = v; renderProps(); refreshItemVisual(); });
    if ((it.mode || 'click') !== 'hold') bindP('pClicks', 'input', (v) => { it.clicks = clamp(+v || 1, 1, 3); refreshItemVisual(); });
  }
  if (it.type === 'touchpad') {
    $('pExpand').addEventListener('change', (e) => { it.expand = e.target.checked; refreshItemVisual(); markDirty(); });
    bindP('pSens', 'input', (v) => { it.sensitivity = clamp(+v || 1.2, 0.2, 4); });
    bindP('pAccel', 'input', (v) => { it.accel = clamp(+v || 0, 0, 3); });
    bindP('pScrollSpd', 'input', (v) => { it.scrollSpeed = clamp(+v || 1, 0.2, 5); });
    bindP('pScrollAccel', 'input', (v) => { it.scrollAccel = clamp(+v || 0, 0, 3); });
    $('pNatural').addEventListener('change', (e) => { it.naturalScroll = e.target.checked; markDirty(); });
    bindGestures(it);
  }
  bindP('pColor', 'input', (v) => { it.color = v; refreshItemVisual(); });
  if (canIcon) {
    if (it.icon) $('pIconFit').value = it.iconFit || 'fit';
    const gridEl = $('pIconGrid');
    $('pIconPick').addEventListener('click', () => {
      gridEl.classList.toggle('hidden');
      if (!gridEl.dataset.filled) {
        gridEl.innerHTML = RDIcons.ids.map((id) =>
          `<button class="ico-pick" data-id="${id}" title="${RDIcons.list[id].n}">${RDIcons.svg(id)}</button>`).join('');
        gridEl.dataset.filled = '1';
        gridEl.querySelectorAll('.ico-pick').forEach((b) => b.addEventListener('click', () => setIcon(it, 'lc:' + b.dataset.id)));
      }
    });
    $('pIconImg').addEventListener('click', async () => { const d = await window.rd.pickImage(); if (d) setIcon(it, d); });
    $('pIconClr').addEventListener('click', () => { delete it.icon; renderProps(); refreshItemVisual(); markDirty(); });
    if (it.icon) {
      bindP('pIconFit', 'change', (v) => { it.iconFit = v; refreshItemVisual(); });
      $('pIconSize').addEventListener('input', (e) => { it.iconSize = +e.target.value; $('pIconSizeV').textContent = e.target.value; refreshItemVisual(); markDirty(); });
    }
  }
  if (grid) {
    const { cols, rows } = gridDims();
    bindP('pGx', 'input', (v) => { it.gx = clamp(snap(+v || 0), 0, cols - (it.gw || 1)); renderGrid(); });
    bindP('pGy', 'input', (v) => { it.gy = clamp(snap(+v || 0), 0, rows - (it.gh || 1)); renderGrid(); });
    bindP('pGw', 'input', (v) => { it.gw = clamp(snap(+v || 1), MINSZ, cols - (it.gx || 0)); renderGrid(); });
    bindP('pGh', 'input', (v) => { it.gh = clamp(snap(+v || 1), MINSZ, rows - (it.gy || 0)); renderGrid(); });
  }
  if (it.type === 'group') $('pOpen').addEventListener('click', () => { navStack.push(it.id); selId = null; renderCanvasAndBar(); });
  if (!grid) {
    $('pLeft').addEventListener('click', () => moveRadial(-1));
    $('pRight').addEventListener('click', () => moveRadial(1));
  }
  $('pDel').addEventListener('click', () => {
    const arr = curLevel().items;
    const i = arr.findIndex((x) => x.id === selId);
    if (i >= 0) arr.splice(i, 1);
    selId = null; renderCanvas(); renderProps(); markDirty();
  });
}
function row(label, inner) { return `<div class="prow"><label>${label}</label>${inner}</div>`; }
function bindP(id, ev, fn) { const el = $(id); if (el) el.addEventListener(ev, (e) => { fn(e.target.value); markDirty(); }); }
function refreshItemVisual() { if (isGridLevel()) renderGrid(); else renderRadial(); renderLayouts(); }
function moveRadial(dir) {
  const arr = L().items, i = arr.findIndex((x) => x.id === selId), j = i + dir;
  if (i < 0 || j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  renderRadial(); markDirty();
}

// ---------- gestures editor (touchpad) ----------
const DIRS = ['left', 'right', 'up', 'down'];
function gesturesHtml(it) {
  const gs = Array.isArray(it.gestures) ? it.gestures : [];
  let h = `<div class="gest"><div class="ghdr">Custom swipe gestures<button class="ghost mini" id="pGestAdd">＋</button></div>`;
  gs.forEach((g, i) => {
    const fSel = [2, 3, 4].map((n) => `<option value="${n}"${(g.fingers || 3) === n ? ' selected' : ''}>${n}f</option>`).join('');
    const dSel = DIRS.map((d) => `<option value="${d}"${(g.dir || 'left') === d ? ' selected' : ''}>${d}</option>`).join('');
    const aSel = ['press', 'hold', 'command'].map((a) => `<option value="${a}"${(g.action || 'press') === a ? ' selected' : ''}>${a}</option>`).join('');
    h += `<div class="grow" data-gi="${i}">
      <select class="gFingers">${fSel}</select>
      <select class="gDir">${dSel}</select>
      <select class="gAction">${aSel}</select>
      <input type="text" class="gCombo" value="${escapeAttr(g.combo || '')}" placeholder="combo" />
      <button class="cap gRec">REC</button>
      <button class="danger mini gDel">✕</button>
    </div>`;
  });
  if (!gs.length) h += `<div class="ghint">No gestures — add one.</div>`;
  h += `</div>`;
  return h;
}
function bindGestures(it) {
  if (!Array.isArray(it.gestures)) it.gestures = [];
  const add = $('pGestAdd');
  if (add) add.addEventListener('click', () => { it.gestures.push({ fingers: 3, dir: 'left', action: 'press', combo: '' }); renderProps(); markDirty(); });
  document.querySelectorAll('#props .grow').forEach((rowEl) => {
    const i = +rowEl.dataset.gi; const g = it.gestures[i]; if (!g) return;
    rowEl.querySelector('.gFingers').addEventListener('change', (e) => { g.fingers = +e.target.value; markDirty(); });
    rowEl.querySelector('.gDir').addEventListener('change', (e) => { g.dir = e.target.value; markDirty(); });
    rowEl.querySelector('.gAction').addEventListener('change', (e) => { g.action = e.target.value; markDirty(); });
    rowEl.querySelector('.gCombo').addEventListener('input', (e) => { g.combo = e.target.value; markDirty(); });
    rowEl.querySelector('.gRec').addEventListener('click', () => captureCombo((c) => { g.combo = c; rowEl.querySelector('.gCombo').value = c; markDirty(); }));
    rowEl.querySelector('.gDel').addEventListener('click', () => { it.gestures.splice(i, 1); renderProps(); markDirty(); });
  });
}

// ---------- combo capture ----------
function captureCombo(cb) {
  const hint = $('captureHint');
  hint.classList.remove('hidden');
  function onKey(e) {
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') { cleanup(); return; }
    const tok = codeToToken(e);
    if (!tok) return;
    const parts = [];
    if (e.ctrlKey) parts.push('ctrl');
    if (e.altKey) parts.push('alt');
    if (e.shiftKey) parts.push('shift');
    if (e.metaKey) parts.push('win');
    parts.push(tok);
    cb(parts.join('+'));
    cleanup();
  }
  function cleanup() { hint.classList.add('hidden'); window.removeEventListener('keydown', onKey, true); }
  window.addEventListener('keydown', onKey, true);
}
function codeToToken(e) {
  const c = e.code;
  if (/^Control|^Shift|^Alt|^Meta/.test(c)) return null;
  if (/^Key([A-Z])$/.test(c)) return c.slice(3).toLowerCase();
  if (/^Digit([0-9])$/.test(c)) return c.slice(5);
  if (/^Numpad([0-9])$/.test(c)) return 'num' + c.slice(6);
  const map = {
    Space: 'space', Enter: 'enter', Tab: 'tab', Backspace: 'backspace', Escape: 'esc',
    Delete: 'delete', Insert: 'insert', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', CapsLock: 'capslock',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
    NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
  };
  if (map[c]) return map[c];
  if (/^F([1-9]|1[0-2])$/.test(c)) return c.toLowerCase();
  return null;
}

// ---------- globals (radial sliders) ----------
$('optRadius').addEventListener('input', (e) => { cfg.overlay.radius = +e.target.value; if (!isGridLevel()) renderRadial(); markDirty(); });
$('optButton').addEventListener('input', (e) => { cfg.overlay.buttonSize = +e.target.value; if (!isGridLevel()) renderRadial(); markDirty(); });
function syncGlobals() { $('optRadius').value = cfg.overlay.radius || 120; $('optButton').value = cfg.overlay.buttonSize || 54; }

// ---------- helpers ----------
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function renderAll() { renderLayouts(); syncGlobals(); renderCanvasAndBar(); }
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function escapeAttr(s) { return escapeHtml(s).replace(/'/g, '&#39;'); }
function shade(hex, pct) {
  const c = (hex || '#5b8cff').replace('#', ''); if (c.length !== 6) return hex || '#5b8cff';
  const cl = (v) => Math.max(0, Math.min(255, Math.round(v)));
  let r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
  r = cl(r + pct / 100 * 255); g = cl(g + pct / 100 * 255); b = cl(b + pct / 100 * 255);
  return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

window.rd.getConfig().then((c) => { cfg = c; sel = Math.min(cfg.activeLayout || 0, cfg.layouts.length - 1); baseline = JSON.stringify(cfg); updateUndoButtons(); renderAll(); });
window.rd.onConfig((c) => { cfg = c; if (sel >= cfg.layouts.length) sel = 0; baseline = JSON.stringify(cfg); renderAll(); });
