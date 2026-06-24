'use strict';
// Renderer for the Gestures window. Edits cfg.gestures + cfg.gestureSettings and persists
// them via window.rd.saveGestures (which updates ONLY the gesture config in main).

const $ = (id) => document.getElementById(id);
let G = [];          // working copy of bindings
let S = {};          // working copy of settings
let dirty = false;
let draft = null;    // binding being edited
let draftIndex = -1; // -1 = new

const DIRS = {
  edge: [['left', 'From left edge'], ['right', 'From right edge']],
  swipe: [['up', 'Up'], ['down', 'Down'], ['left', 'Left'], ['right', 'Right']],
  pinch: [['in', 'Pinch in'], ['out', 'Pinch out']],
  rotate: [['cw', 'Clockwise'], ['ccw', 'Counter-clockwise']],
};
const KIND_LABEL = { edge: 'Edge', swipe: 'Swipe', tap: 'Tap', pinch: 'Pinch', rotate: 'Rotate', path: 'Path', custom: 'Custom' };
const VERB_LABEL = { 'toggle-deck': 'Show/hide deck', 'show-deck': 'Show deck', 'hide-deck': 'Hide deck', 'next-layout': 'Next layout', 'prev-layout': 'Prev layout', 'collapse-toggle': 'Collapse' };
const SHAPE_LABEL = { circle: 'Circle', 'half-circle': 'Half circle', s: 'S', 's-side': 'Sideways S', figure8: 'Figure 8' };

function gid() { return 'g' + Math.random().toString(36).slice(2, 9); }
function markDirty() { dirty = true; const s = $('saveState'); s.textContent = 'unsaved'; s.classList.add('dirty'); }
function markSaved() { dirty = false; const s = $('saveState'); s.textContent = 'saved'; s.classList.remove('dirty'); }

// ---------- describe a binding ----------
function metaText(b) {
  const parts = [KIND_LABEL[b.kind] || b.kind];
  if (b.kind !== 'edge') parts.push(b.fingers + 'f'); else parts.push('1f');
  if (b.dir) parts.push(b.dir);
  if (b.kind === 'path' && b.shape) parts.push(SHAPE_LABEL[b.shape] || b.shape);
  if (b.kind === 'custom') parts.push(b.points && b.points.length ? 'recorded' : 'not recorded');
  return parts.join(' · ');
}
function actText(b) {
  if (b.action === 'command') return '▶ ' + (b.combo || '(no command)');
  if (b.action === 'rd-control') return '⊞ ' + (VERB_LABEL[b.combo] || b.combo || '(no control)');
  return '⌨ ' + (b.combo || '(no keys)');
}

// ---------- list ----------
function renderList() {
  const wrap = $('rows');
  wrap.innerHTML = '';
  if (!G.length) { wrap.innerHTML = '<div class="empty">No gestures yet. Click <b>Add gesture</b>.</div>'; return; }
  G.forEach((b, i) => {
    const el = document.createElement('div');
    el.className = 'grow' + (b.enabled ? '' : ' disabled');
    el.innerHTML =
      '<div class="gname"></div>' +
      '<div class="gmeta"></div>' +
      '<div class="gact"></div>' +
      '<div class="gctl">' +
        '<label class="switch" style="font-size:12px;"><input type="checkbox" ' + (b.enabled ? 'checked' : '') + ' data-en="' + i + '"/> on</label>' +
        '<span><button class="ghost" data-edit="' + i + '">Edit</button> <button class="danger" data-del="' + i + '">✕</button></span>' +
      '</div>';
    el.querySelector('.gname').textContent = b.name || '(unnamed)';
    el.querySelector('.gmeta').textContent = metaText(b);
    el.querySelector('.gact').textContent = actText(b);
    wrap.appendChild(el);
  });
  wrap.querySelectorAll('[data-en]').forEach((c) => c.addEventListener('change', (e) => {
    G[+e.target.dataset.en].enabled = e.target.checked; markDirty(); renderList();
  }));
  wrap.querySelectorAll('[data-edit]').forEach((c) => c.addEventListener('click', (e) => openEditor(+e.target.dataset.edit)));
  wrap.querySelectorAll('[data-del]').forEach((c) => c.addEventListener('click', (e) => {
    G.splice(+e.target.dataset.del, 1); markDirty(); renderList(); closeEditor();
  }));
}

// ---------- editor panel ----------
function fillDirs(kind, sel) {
  const dd = $('edDir'); dd.innerHTML = '';
  (DIRS[kind] || []).forEach(([v, label]) => {
    const o = document.createElement('option'); o.value = v; o.textContent = label; dd.appendChild(o);
  });
  if (sel) dd.value = sel;
}
function syncFields() {
  const kind = $('edKind').value;
  const action = $('edAction').value;
  $('edDirWrap').classList.toggle('hidden', !DIRS[kind]);
  $('edShapeWrap').classList.toggle('hidden', kind !== 'path');
  $('recWrap').classList.toggle('hidden', kind !== 'custom');
  // edge gestures are 1-finger
  $('edFingers').disabled = (kind === 'edge');
  if (kind === 'edge') $('edFingers').value = '1';
  $('edComboWrap').classList.toggle('hidden', action === 'rd-control');
  $('edVerbWrap').classList.toggle('hidden', action !== 'rd-control');
  $('edComboLabel').textContent = action === 'command' ? 'Command / app to launch' : 'Keys';
  $('btnCapture').classList.toggle('hidden', action !== 'press');
  $('edCombo').placeholder = action === 'command' ? 'e.g. notepad   or   C:\\path\\app.exe' : 'e.g. ctrl+shift+s';
}
function openEditor(index) {
  draftIndex = index;
  draft = index >= 0 ? JSON.parse(JSON.stringify(G[index])) : { id: gid(), name: '', kind: 'swipe', fingers: 3, dir: 'up', shape: 'circle', points: null, action: 'press', combo: '', enabled: true };
  $('edTitle').textContent = index >= 0 ? 'Edit gesture' : 'New gesture';
  $('edName').value = draft.name || '';
  $('edKind').value = draft.kind;
  $('edFingers').value = String(draft.fingers || 3);
  fillDirs(draft.kind, draft.dir);
  $('edShape').value = draft.shape || 'circle';
  $('edAction').value = draft.action || 'press';
  if (draft.action === 'rd-control') $('edVerb').value = draft.combo || 'toggle-deck';
  else $('edCombo').value = draft.combo || '';
  syncFields();
  drawTemplate(draft.points);
  $('recState').textContent = (draft.points && draft.points.length) ? 'Gesture recorded ✓' : 'No gesture recorded yet.';
  $('editorPanel').classList.remove('hidden');
  $('sideEmpty').classList.add('hidden');
}
function closeEditor() {
  $('editorPanel').classList.add('hidden');
  $('sideEmpty').classList.remove('hidden');
  draft = null; draftIndex = -1;
}
function applyEditor() {
  if (!draft) return;
  const kind = $('edKind').value;
  draft.name = $('edName').value.trim() || autoName();
  draft.kind = kind;
  draft.fingers = kind === 'edge' ? 1 : (+$('edFingers').value || 3);
  draft.dir = DIRS[kind] ? $('edDir').value : null;
  draft.shape = kind === 'path' ? $('edShape').value : null;
  draft.action = $('edAction').value;
  draft.combo = draft.action === 'rd-control' ? $('edVerb').value : $('edCombo').value.trim();
  if (kind !== 'custom') draft.points = null;
  if (kind === 'custom' && (!draft.points || !draft.points.length)) { alert('Record the custom gesture first.'); return; }
  if (draftIndex >= 0) G[draftIndex] = draft; else G.push(draft);
  markDirty(); renderList(); closeEditor();
}
function autoName() {
  const k = $('edKind').value;
  const f = k === 'edge' ? '1' : $('edFingers').value;
  const d = DIRS[k] ? ' ' + $('edDir').value : (k === 'path' ? ' ' + $('edShape').value : '');
  return f + 'f ' + KIND_LABEL[k] + d;
}

// ---------- key capture ----------
let capturing = false;
function startCapture() {
  capturing = true;
  $('btnCapture').textContent = 'Press keys… (Esc to cancel)';
}
window.addEventListener('keydown', (e) => {
  if (!capturing) return;
  e.preventDefault();
  if (e.key === 'Escape') { capturing = false; $('btnCapture').textContent = '⌨ Capture keys…'; return; }
  const mods = [];
  if (e.ctrlKey) mods.push('ctrl');
  if (e.altKey) mods.push('alt');
  if (e.shiftKey) mods.push('shift');
  if (e.metaKey) mods.push('win');
  const k = e.key.toLowerCase();
  const isMod = ['control', 'alt', 'shift', 'meta'].includes(k);
  if (isMod) return; // wait for the non-modifier key
  let main = k;
  const map = { ' ': 'space', arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right', escape: 'esc', enter: 'enter', tab: 'tab', backspace: 'backspace', delete: 'delete' };
  if (map[k]) main = map[k];
  const combo = mods.concat([main]).join('+');
  $('edCombo').value = combo;
  capturing = false; $('btnCapture').textContent = '⌨ Capture keys…';
});

// ---------- custom recording ----------
function drawTemplate(points) {
  const c = $('recCanvas'); const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  if (!points || !points.length) return;
  // points are normalized around origin (~ -0.6..0.6). Map to canvas with padding.
  const pad = 14, w = c.width - pad * 2, h = c.height - pad * 2;
  ctx.strokeStyle = '#9b6cff'; ctx.lineWidth = 2; ctx.beginPath();
  points.forEach((p, i) => {
    const x = pad + (p.x + 0.6) / 1.2 * w;
    const y = pad + (p.y + 0.6) / 1.2 * h;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  // start dot
  const s = points[0]; ctx.fillStyle = '#46c08f';
  ctx.beginPath(); ctx.arc(pad + (s.x + 0.6) / 1.2 * w, pad + (s.y + 0.6) / 1.2 * h, 4, 0, Math.PI * 2); ctx.fill();
}
async function recordCustom() {
  const fingers = +$('edFingers').value || 3;
  $('recState').textContent = 'Perform the ' + fingers + '-finger gesture now…';
  $('btnRecord').disabled = true;
  try {
    const res = await window.rd.recordGesture(fingers);
    if (res && res.ok && res.points && res.points.length) {
      draft.points = res.points;
      draft.fingers = res.fingers || fingers;
      drawTemplate(draft.points);
      $('recState').textContent = 'Gesture recorded ✓ (' + (res.fingers || fingers) + ' fingers)';
    } else if (res && res.timeout) {
      $('recState').textContent = 'Timed out — try again.';
    } else {
      $('recState').textContent = 'No gesture captured — try again.';
    }
  } catch (e) {
    $('recState').textContent = 'Recording failed.';
  }
  $('btnRecord').disabled = false;
}

// ---------- settings ----------
function loadSettings() {
  $('masterEnable').checked = S.enabled !== false;
  $('captureMulti').checked = !!S.captureMultiFinger;
  $('setEdge').value = S.edgeMarginPx; $('setSwipe').value = S.minSwipePx;
  $('setTapPx').value = S.tapMaxPx; $('setTapMs').value = S.tapMaxMs;
  $('setRot').value = S.rotateMinDeg; $('setPinch').value = S.pinchMinRatio;
  $('setScore').value = S.pathMinScore; $('setCool').value = S.cooldownMs;
}
function bindSetting(id, key, isFloat) {
  $(id).addEventListener('change', (e) => { const v = isFloat ? parseFloat(e.target.value) : parseInt(e.target.value, 10); if (!isNaN(v)) { S[key] = v; markDirty(); } });
}

// ---------- save / load ----------
function save() {
  // pull live settings
  S.enabled = $('masterEnable').checked;
  S.captureMultiFinger = $('captureMulti').checked;
  window.rd.saveGestures({ gestures: G, gestureSettings: S });
  markSaved();
}
function loadFrom(cfg) {
  G = JSON.parse(JSON.stringify(cfg.gestures || []));
  S = JSON.parse(JSON.stringify(cfg.gestureSettings || {}));
  loadSettings();
  renderList();
  markSaved();
}

// ---------- wire up ----------
window.addEventListener('DOMContentLoaded', async () => {
  const cfg = await window.rd.getConfig();
  loadFrom(cfg || {});

  $('btnAdd').addEventListener('click', () => openEditor(-1));
  $('btnApply').addEventListener('click', applyEditor);
  $('btnCancel').addEventListener('click', closeEditor);
  $('btnSave').addEventListener('click', save);
  $('btnAdvanced').addEventListener('click', () => $('advanced').classList.toggle('hidden'));
  $('btnRecord').addEventListener('click', recordCustom);
  $('btnCapture').addEventListener('click', startCapture);
  $('edKind').addEventListener('change', () => { fillDirs($('edKind').value, null); syncFields(); });
  $('edAction').addEventListener('change', syncFields);
  $('masterEnable').addEventListener('change', markDirty);
  $('captureMulti').addEventListener('change', markDirty);

  bindSetting('setEdge', 'edgeMarginPx'); bindSetting('setSwipe', 'minSwipePx');
  bindSetting('setTapPx', 'tapMaxPx'); bindSetting('setTapMs', 'tapMaxMs');
  bindSetting('setRot', 'rotateMinDeg'); bindSetting('setPinch', 'pinchMinRatio', true);
  bindSetting('setScore', 'pathMinScore', true); bindSetting('setCool', 'cooldownMs');

  // external config changes (e.g. layout editor) — refresh only if we have no unsaved work
  window.rd.onConfig((c) => { if (!dirty && c) loadFrom(c); });

  window.addEventListener('keydown', (e) => { if (e.key === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); } });
});
