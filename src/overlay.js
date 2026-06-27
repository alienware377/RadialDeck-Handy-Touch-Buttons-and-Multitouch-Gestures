'use strict';
const PAD = 16, ORBR = 64, ORBG = 52, COLLAPSE = 120, STEP_PX = 18; // COLLAPSE leaves a margin so the orb's drop-shadow isn't clipped by the window edge
const ORB_VIS = 36;         // visual radius of the 64px orb (incl. ring/shadow) — used for edge-fit bounds
const ORB_HALF = 33;        // clearance kept between the orb centre and the button block (matches the old grid orbBar/2)
const EDGE_M = 40;          // keep the orb at least this far inside the work area so it's always fully visible/grabbable

let cfg = null;
let active = 0;
let navStack = [];          // group ids drilled into
let collapsed = false;
let winX = 0, winY = 0;     // our tracked window top-left (DIP)
let orbCenter = { x: 180, y: 180 };
let lastW = 0, lastH = 0;   // the window size we're currently rendered at (for drag-start retract tracking)

const panel = document.getElementById('panel');
const orb = document.getElementById('orb');
const orbGlyph = document.getElementById('orbGlyph');
const orbLabel = document.getElementById('orbLabel');

const layout = () => cfg.layouts[active] || cfg.layouts[0];

// ---------- resolve current drill level ----------
function resolveGroup() {
  let cur = layout().items, grp = null;
  for (const id of navStack) {
    // a drill-in target is a group OR an expandable touchpad (terminal: opens a full pad)
    const g = (cur || []).find((it) => it.id === id && (it.type === 'group' || (it.type === 'touchpad' && it.expand)));
    if (!g) { navStack = []; return { items: layout().items, group: null }; }
    grp = g; cur = g.items || [];
  }
  return { items: cur, group: grp };
}
function level() {
  const L = layout();
  const cell = L.cell || 60, gap = L.gap || 8;
  if (collapsed) return { renderMode: 'collapsed', items: [], cell, gap, cols: 0, rows: 0 };
  if (navStack.length) {
    const { items, group } = resolveGroup();
    if (group && group.type === 'touchpad') return { renderMode: 'touchpad', pad: group, items: [], cell, gap, cols: 0, rows: 0 };
    return { renderMode: 'grid', items, cell, gap, cols: spanCols(items), rows: spanRows(items) };
  }
  if (L.mode === 'grid') return { renderMode: 'grid', items: L.items, cell, gap, cols: L.cols || spanCols(L.items), rows: L.rows || spanRows(L.items) };
  return { renderMode: 'radial', items: L.items, cell, gap, cols: 0, rows: 0 };
}
const spanCols = (items) => Math.max(1, ...items.map((i) => (i.gx || 0) + (i.gw || 1)));
const spanRows = (items) => Math.max(1, ...items.map((i) => (i.gy || 0) + (i.gh || 1)));

// ---------- size for a level ----------
function sizeFor(lv) {
  if (lv.renderMode === 'collapsed') return { w: COLLAPSE, h: COLLAPSE, orbX: COLLAPSE / 2, orbY: COLLAPSE / 2, gridTop: 0, gridLeft: 0 };
  if (lv.renderMode === 'touchpad') {
    const pw = lv.pad.padW || 300, ph = lv.pad.padH || 360, orbBar = ORBG + 14;
    const w = pw + 2 * PAD, h = orbBar + ph + PAD;
    return { w, h, orbX: w / 2, orbY: orbBar / 2, gridTop: orbBar, gridLeft: PAD, padW: pw, padH: ph };
  }
  if (lv.renderMode === 'radial') {
    const R = cfg.overlay.radius || 120, bs = cfg.overlay.buttonSize || 54;
    const D = 2 * R + bs + 2 * PAD;
    return { w: D, h: D, orbX: D / 2, orbY: D / 2, gridTop: 0, gridLeft: 0 };
  }
  const gw = lv.cols * lv.cell + (lv.cols - 1) * lv.gap;
  const gh = lv.rows * lv.cell + (lv.rows - 1) * lv.gap;
  const orbBar = ORBG + 14;
  const w = gw + 2 * PAD;
  const h = orbBar + gh + PAD;
  return { w, h, orbX: w / 2, orbY: orbBar / 2, gridTop: orbBar, gridLeft: PAD };
}

// ---------- render ----------
function render(lv, sz) {
  document.body.classList.toggle('collapsed', lv.renderMode === 'collapsed');
  const L = layout();
  const inGroup = navStack.length > 0;
  orbGlyph.textContent = inGroup ? '‹' : (L.name || '?').trim().charAt(0).toUpperCase();
  orb.style.background = `radial-gradient(circle at 35% 30%, ${shade(L.color, 30)}, ${L.color} 70%, ${shade(L.color, -40)})`;
  orb.style.left = sz.orbX + 'px'; orb.style.top = sz.orbY + 'px';
  orbLabel.style.left = sz.orbX + 'px'; orbLabel.style.top = (sz.orbY + (lv.renderMode === 'radial' ? ORBR / 2 + 10 : ORBG / 2 + 2)) + 'px';
  orbLabel.textContent = inGroup ? (resolveGroup().group?.label || '') : (L.name || '');
  if (lv.renderMode !== 'collapsed') pokeOrbLabel(); // show now, auto-fade after a couple secs

  panel.innerHTML = '';
  if (lv.renderMode === 'collapsed') return;
  if (lv.renderMode === 'touchpad') { renderTouchpadSurface(lv, sz); return; }
  if (lv.renderMode === 'radial') renderRadial(lv, sz);
  else renderGrid(lv, sz);
}

function renderTouchpadSurface(lv, sz) {
  const it = lv.pad;
  const el = document.createElement('div');
  el.className = 'touchpad interactive';
  el.style.left = sz.gridLeft + 'px'; el.style.top = sz.gridTop + 'px';
  el.style.width = sz.padW + 'px'; el.style.height = sz.padH + 'px';
  el.style.background = `linear-gradient(160deg, ${shade(it.color, -6)}, ${shade(it.color, -24)})`;
  el.innerHTML = `<span class="hint">drag = move&nbsp;·&nbsp;tap = click<br>2 fingers: scroll · tap = right<br>3 fingers: gestures</span>`;
  bindTouchpad(el, it);
  panel.appendChild(el);
}

function renderRadial(lv, sz) {
  const R = cfg.overlay.radius || 120, bs = cfg.overlay.buttonSize || 54;
  const n = lv.items.length;
  lv.items.forEach((it, i) => {
    // angle comes from the edge-fit pass (sz.angs): full circle when the orb has room
    // on all sides, otherwise a half/quarter pie pointed at the open space.
    const ang = (sz.angs && sz.angs[i] != null) ? sz.angs[i] : (-Math.PI / 2 + (i / n) * Math.PI * 2);
    const el = document.createElement('div');
    el.className = 'key interactive';
    el.style.left = (sz.orbX + R * Math.cos(ang)) + 'px';
    el.style.top = (sz.orbY + R * Math.sin(ang)) + 'px';
    el.style.width = bs + 'px'; el.style.height = bs + 'px';
    paint(el, it);
    bindItem(el, it);
    panel.appendChild(el);
  });
}

function renderGrid(lv, sz) {
  const step = lv.cell + lv.gap;
  lv.items.forEach((it) => {
    const x = sz.gridLeft + (it.gx || 0) * step;
    const y = sz.gridTop + (it.gy || 0) * step;
    const w = (it.gw || 1) * step - lv.gap;
    const h = (it.gh || 1) * step - lv.gap;
    let el;
    if (it.type === 'scroll') {
      el = document.createElement('div');
      el.className = 'scrollw interactive' + (it.axis === 'h' ? ' h' : '');
      el.style.background = `linear-gradient(${it.axis === 'h' ? '90deg' : '180deg'}, ${shade(it.color, 20)}, ${it.color})`;
      el.innerHTML = `<span class="grip">⋮⋮⋮</span>`;
      bindScroll(el, it);
    } else if (it.type === 'group') {
      el = document.createElement('div');
      el.className = 'gridgroup interactive';
      el.style.background = `linear-gradient(160deg, ${shade(it.color, 20)}, ${it.color})`;
      el.innerHTML = (RDIcons.html(it) || `<span>${esc(it.label || '')}</span>`) + `<span class="folder">▸</span>`;
      el.addEventListener('pointerdown', (e) => { e.preventDefault(); openGroup(it.id); });
    } else if (it.type === 'touchpad') {
      el = document.createElement('div');
      if (it.expand) {                                    // acts as a button -> opens full pad
        el.className = 'gridgroup interactive';
        el.style.background = `linear-gradient(160deg, ${shade(it.color, 20)}, ${it.color})`;
        el.innerHTML = `<span>${esc(it.label || 'Trackpad')}</span><span class="folder">⊕</span>`;
        el.addEventListener('pointerdown', (e) => { e.preventDefault(); openGroup(it.id); });
      } else {                                            // inline touchpad surface
        el.className = 'touchpad interactive';
        el.style.background = `linear-gradient(160deg, ${shade(it.color, -6)}, ${shade(it.color, -24)})`;
        el.innerHTML = `<span class="hint">${esc(it.label || 'Trackpad')}</span>`;
        bindTouchpad(el, it);
      }
    } else if (it.type === 'mousebtn') {
      el = document.createElement('div');
      el.className = 'gkey interactive';
      el.style.background = `linear-gradient(160deg, ${shade(it.color, 18)}, ${it.color})`;
      const btn = it.button || 'l';
      const mbBadge = it.mode === 'hold' ? btn.toUpperCase() + '↓'
        : btn.toUpperCase() + ((it.clicks || 1) > 1 ? '×' + it.clicks : '');
      el.innerHTML = (RDIcons.html(it) || `<span>${esc(it.label || '')}</span>`) + `<span class="badge">${mbBadge}</span>`;
      if (it.mode === 'hold') {
        // press-and-hold: button down while finger is on the key, up on release (like a hold key)
        el.addEventListener('pointerdown', (e) => { e.preventDefault(); interacting++; el.classList.add('held'); window.rd.tpButton('down', btn); });
        const up = () => { if (!el.classList.contains('held')) return; el.classList.remove('held'); interacting = Math.max(0, interacting - 1); window.rd.tpButton('up', btn); };
        el.addEventListener('pointerup', up); el.addEventListener('pointerleave', up); el.addEventListener('pointercancel', up);
      } else {
        el.addEventListener('pointerdown', (e) => { e.preventDefault(); flash(el); window.rd.tpButton('click', btn, it.clicks || 1); });
      }
    } else {
      el = document.createElement('div');
      el.className = 'gkey interactive';
      paint(el, it);
      bindItem(el, it);
    }
    el.style.left = x + 'px'; el.style.top = y + 'px';
    el.style.width = w + 'px'; el.style.height = h + 'px';
    panel.appendChild(el);
  });
}

function paint(el, k) {
  el.style.background = `linear-gradient(160deg, ${shade(k.color, 18)}, ${k.color})`;
  el.dataset.id = k.id;
  const ico = RDIcons.html(k);
  el.innerHTML = (ico || `<span>${esc(k.label || k.combo || '')}</span>`) +
    (k.action && k.action !== 'press' ? `<span class="badge">${badge(k.action)}</span>` : '');
  // gesture-toggle buttons reflect the live engine state (lit = gestures on)
  if (k.action === 'gesture-toggle') el.classList.toggle('on', !!(cfg && cfg.gestureSettings && cfg.gestureSettings.enabled !== false));
}
const badge = (a) => (a === 'hold' ? 'HLD' : a === 'toggle' ? 'TGL' : a === 'command' ? 'CMD' : a === 'gesture-toggle' ? 'GES' : '');

// ---------- item interactions ----------
let interacting = 0;
function bindItem(el, k) {
  if (k.action === 'hold') {
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); interacting++; el.classList.add('held'); window.rd.keyAction({ id: k.id, combo: k.combo, action: 'hold', phase: 'down' }); });
    const up = () => { if (!el.classList.contains('held')) return; el.classList.remove('held'); interacting = Math.max(0, interacting - 1); window.rd.keyAction({ id: k.id, combo: k.combo, action: 'hold', phase: 'up' }); };
    el.addEventListener('pointerup', up); el.addEventListener('pointerleave', up); el.addEventListener('pointercancel', up);
  } else if (k.action === 'toggle') {
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); window.rd.keyAction({ id: k.id, combo: k.combo, action: 'toggle', phase: 'down' }); });
  } else if (k.action === 'gesture-toggle') {
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); window.rd.keyAction({ id: k.id, action: 'gesture-toggle', phase: 'down' }); });
  } else {
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); flash(el); window.rd.keyAction({ id: k.id, combo: k.combo, action: k.action }); });
  }
}
function flash(el) { el.classList.add('active'); setTimeout(() => el.classList.remove('active'), 110); }
window.rd.onToggleState(({ id, on }) => { const el = panel.querySelector(`[data-id="${id}"]`); if (el) el.classList.toggle('on', on); });

// ---------- scroll widget ----------
function bindScroll(el, it) {
  let info = null;
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault(); interacting++; el.setPointerCapture(e.pointerId);
    window.rd.scrollBegin(); // snapshot the user's focused window NOW, before they touch the widget
    info = { last: it.axis === 'h' ? e.clientX : e.clientY, acc: 0 };
    el.classList.add('dragging');
  });
  el.addEventListener('pointermove', (e) => {
    if (!info) return;
    const cur = it.axis === 'h' ? e.clientX : e.clientY;
    info.acc += cur - info.last; info.last = cur;
    while (info.acc >= STEP_PX) { emit(-1); info.acc -= STEP_PX; }
    while (info.acc <= -STEP_PX) { emit(1); info.acc += STEP_PX; }
  });
  const end = () => { if (!info) return; info = null; el.classList.remove('dragging'); interacting = Math.max(0, interacting - 1); };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  function emit(sign) {
    let amount = sign * 120 * (it.step || 1);
    if (it.invert) amount = -amount;
    window.rd.scroll({ amount, horizontal: it.axis === 'h' });
  }
}

// ---------- touchpad: multitouch trackpad + custom gestures ----------
// One finger = move cursor (tap = left click, tap-then-hold = drag). Two fingers =
// scroll (tap = right click). Three fingers = swipe gestures (tap = middle click).
// All synthesized into real OS mouse events via the keyboard backend.
const TP_SLOP = 8, TP_TAP_MS = 350, TP_DBL_MS = 320, TP_SCROLL_STEP = 16, TP_SWIPE_MIN = 45;
const TP_DRAG_ARM_MS = 450; // window after a 1-finger tap in which a second tap+move starts a click-drag
function centroid(m) {
  let x = 0, y = 0, n = 0;
  for (const p of m.values()) { x += p.x; y += p.y; n++; }
  return n ? { x: x / n, y: y / n } : { x: 0, y: 0 };
}
function bindTouchpad(el, it) {
  const st = { pts: new Map(), peak: 0, moved: false, t0: 0, mode: 'idle',
    sBegun: false, accX: 0, accY: 0, fx: 0, fy: 0, cx: 0, cy: 0, sx: 0, sy: 0,
    gFired: false, swiped: false, dragging: false, armDrag: 0 };
  const gain = () => (it.sensitivity || 1.2) * (window.devicePixelRatio || 1);

  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    interacting++;
    st.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const n = st.pts.size; st.peak = Math.max(st.peak, n);
    const c = centroid(st.pts); st.cx = c.x; st.cy = c.y;
    if (n === 1) {
      st.t0 = performance.now(); st.moved = false; st.gFired = false; st.swiped = false;
      st.fx = 0; st.fy = 0; st.sx = e.clientX; st.sy = e.clientY; st.mode = 'move';
      if (st.armDrag && performance.now() - st.armDrag < TP_DRAG_ARM_MS) { st.dragging = true; window.rd.tpButton('down', 'l'); }
      st.armDrag = 0;
    } else if (n === 2) { st.mode = 'scroll'; st.sBegun = false; st.accX = 0; st.accY = 0; }
    else if (n >= 3) { st.mode = 'gesture'; st.sx = c.x; st.sy = c.y; }
  });

  el.addEventListener('pointermove', (e) => {
    const p = st.pts.get(e.pointerId); if (!p) return;
    const ox = p.x, oy = p.y; p.x = e.clientX; p.y = e.clientY;
    const n = st.pts.size;
    const now = performance.now();
    const dt = Math.min(64, Math.max(1, now - (st.lastT || now))); st.lastT = now; // ms since last move (clamped)
    if (n === 1 && st.peak === 1 && st.mode === 'move') {
      if (Math.hypot(e.clientX - st.sx, e.clientY - st.sy) > TP_SLOP) st.moved = true;
      const dxr = e.clientX - ox, dyr = e.clientY - oy;
      const accel = it.accel || 0;                     // velocity-scaled boost (px/ms): faster flick => more gain
      const g = gain() * (accel ? 1 + accel * (Math.hypot(dxr, dyr) / dt) : 1);
      const mx = dxr * g + st.fx, my = dyr * g + st.fy;
      const ix = Math.round(mx), iy = Math.round(my);
      st.fx = mx - ix; st.fy = my - iy;               // carry the sub-pixel remainder for smooth slow drags
      if (ix || iy) window.rd.tpMove(ix, iy);
    } else if (n === 2 && st.mode === 'scroll') {
      const c = centroid(st.pts);
      const dx = c.x - st.cx, dy = c.y - st.cy; st.cx = c.x; st.cy = c.y;
      if (Math.abs(dx) + Math.abs(dy) > 0) st.moved = true;
      if (!st.sBegun) { window.rd.scrollBegin(); st.sBegun = true; }
      const inv = it.naturalScroll ? -1 : 1;
      const sAccel = it.scrollAccel || 0;
      const sp = (it.scrollSpeed || 1) * (sAccel ? 1 + sAccel * ((Math.abs(dx) + Math.abs(dy)) / dt) : 1);
      st.accY += dy * inv; st.accX += dx * inv;
      while (st.accY >= TP_SCROLL_STEP) { window.rd.scroll({ amount: -120 * sp, horizontal: false }); st.accY -= TP_SCROLL_STEP; }
      while (st.accY <= -TP_SCROLL_STEP) { window.rd.scroll({ amount: 120 * sp, horizontal: false }); st.accY += TP_SCROLL_STEP; }
      while (st.accX >= TP_SCROLL_STEP) { window.rd.scroll({ amount: 120 * sp, horizontal: true }); st.accX -= TP_SCROLL_STEP; }
      while (st.accX <= -TP_SCROLL_STEP) { window.rd.scroll({ amount: -120 * sp, horizontal: true }); st.accX += TP_SCROLL_STEP; }
    } else if (n >= 3 && st.mode === 'gesture') {
      const c = centroid(st.pts);
      if (Math.hypot(c.x - st.sx, c.y - st.sy) > TP_SLOP) st.moved = true;
    }
  });

  const lift = (e) => {
    if (!st.pts.has(e.pointerId)) return;
    interacting = Math.max(0, interacting - 1);
    // evaluate a swipe on the FIRST finger leaving a 3+ set (all contacts still present)
    if (st.mode === 'gesture' && !st.gFired && st.pts.size >= 3) {
      st.gFired = true;
      const c = centroid(st.pts);
      const dx = c.x - st.sx, dy = c.y - st.sy, ax = Math.abs(dx), ay = Math.abs(dy);
      if (Math.max(ax, ay) > TP_SWIPE_MIN) {
        const dir = ax > ay ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
        const g = (it.gestures || []).find((x) => (x.fingers || 3) === st.peak && x.dir === dir);
        if (g && g.combo) { window.rd.keyAction({ combo: g.combo, action: g.action || 'press' }); st.swiped = true; }
      }
    }
    try { el.releasePointerCapture(e.pointerId); } catch {}
    st.pts.delete(e.pointerId);
    if (st.pts.size === 0) {
      const dur = performance.now() - st.t0;
      const tap = !st.moved && dur < TP_TAP_MS;
      if (st.dragging) { window.rd.tpButton('up', 'l'); }
      else if (!st.swiped && tap) {
        if (st.peak === 1) { window.rd.tpButton('click', 'l'); st.armDrag = performance.now(); } // arm a quick second-tap drag
        else if (st.peak === 2) window.rd.tpButton('click', 'r');
        else if (st.peak >= 3) window.rd.tpButton('click', 'm');
      }
      st.peak = 0; st.mode = 'idle'; st.moved = false; st.dragging = false; st.swiped = false; st.gFired = false;
    }
  };
  el.addEventListener('pointerup', lift);
  el.addEventListener('pointercancel', lift);
}

// ---------- orb: tap / long-press / drag ----------
let drag = null, longTimer = null, longFired = false;
let dragBox = null;   // {w,h,ox,oy} the window size + orb offset the drag is currently tracking at
orb.addEventListener('pointerdown', (e) => {
  if (e.button === 2) return;
  e.preventDefault();
  drag = { sx: e.clientX, sy: e.clientY, moved: false };
  longFired = false;
  orb.setPointerCapture(e.pointerId);
  capture();
  if (!collapsed) pokeOrbLabel();   // touching the orb re-reveals its label, then it fades again
  longTimer = setTimeout(onLongPress, 500);
});
orb.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dist = Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy);
  if (!drag.moved && dist > 4) { drag.moved = true; clearTimeout(longTimer); enterDragCollapsing(); }
  if (drag.moved) followCursor(e.clientX, e.clientY);
});
function endDrag(cancelled) {
  clearTimeout(longTimer);
  if (!drag) return;
  if (drag.moved) {
    // settle into the collapsed orb wherever it ended up (even if the retract
    // animation was still mid-flight), keeping the orb pinned to its screen spot.
    transToken++;                                  // cancel any pending collapseDuringDrag
    if (!collapsed) { collapsed = true; navStack = []; }
    const ax = winX + orbCenter.x, ay = winY + orbCenter.y;
    const lv = level(); const sz = sizeFor(lv);    // collapsed -> COLLAPSE box
    render(lv, sz);
    const p = clampPos(Math.round(ax - sz.orbX), Math.round(ay - sz.orbY), sz.w, sz.h);
    winX = p.x; winY = p.y; orbCenter = { x: sz.orbX, y: sz.orbY }; dragBox = null;
    window.rd.setOverlayBounds({ x: winX, y: winY, width: sz.w, height: sz.h, persist: true, collapsed: true });
  } else if (!longFired && !cancelled) {
    onTap();
  }
  drag = null;
}
orb.addEventListener('pointerup', () => endDrag(false));
orb.addEventListener('pointercancel', () => endDrag(true));
orb.addEventListener('contextmenu', (e) => { e.preventDefault(); window.rd.openEditor(); });

function onLongPress() {
  if (!drag || drag.moved) return;
  longFired = true;
  if (navStack.length) changeState(() => { navStack = []; });          // back to layout root
  else changeState(() => { active = (active + 1) % cfg.layouts.length; navStack = []; collapsed = false; window.rd.setActiveLayout(active); });
}
function onTap() {
  if (navStack.length) changeState(() => { navStack.pop(); });
  else changeState(() => { collapsed = !collapsed; if (collapsed) navStack = []; }, true);
}
function openGroup(id) { changeState(() => { navStack.push(id); collapsed = false; }); }

// Drag-start: retract the current buttons into the orb (same spring as minimize)
// while the still-large window keeps tracking the finger, THEN snap to the orb.
function enterDragCollapsing() {
  const kids = [...panel.children];
  if (collapsed || !kids.length || reduceMotion) { collapseDuringDrag(); return; }
  // track at the current (large) RENDERED size during the retract. Use the live geometry
  // (which may be an edge-fit window, not the default sizeFor box) so the orb doesn't jump.
  dragBox = { w: lastW, h: lastH, ox: orbCenter.x, oy: orbCenter.y };
  const token = ++transToken;
  orbPop();
  kids.forEach((el) => { emanate(el, orbCenter.x, orbCenter.y); el.style.pointerEvents = 'none'; el.classList.add('rd-out'); });
  setTimeout(() => { if (token === transToken && drag && drag.moved) collapseDuringDrag(); }, OUT_MS);
}
// switch the drag to the small orb box, keeping the orb pinned under the finger
function collapseDuringDrag() {
  const ax = winX + orbCenter.x, ay = winY + orbCenter.y;
  collapsed = true; navStack = [];
  const lv = level(); const sz = sizeFor(lv);
  render(lv, sz);
  dragBox = { w: sz.w, h: sz.h, ox: sz.orbX, oy: sz.orbY };
  const p = clampPos(Math.round(ax - sz.orbX), Math.round(ay - sz.orbY), sz.w, sz.h);
  winX = p.x; winY = p.y; orbCenter = { x: sz.orbX, y: sz.orbY };
  window.rd.setOverlayBounds({ x: winX, y: winY, width: sz.w, height: sz.h });
}
function followCursor(clientX, clientY) {
  // Absolute cursor position in screen DIP = live window origin + client offset.
  // Both are measured from the ACTUAL window, so their sum is the true cursor point
  // regardless of how far the async setOverlayBounds has caught up (no runaway drift).
  // dragBox is the size we're currently tracking at (large during the retract, then COLLAPSE).
  const box = dragBox || { w: COLLAPSE, h: COLLAPSE, ox: COLLAPSE / 2, oy: COLLAPSE / 2 };
  const cx = window.screenX + clientX, cy = window.screenY + clientY;
  const p = clampPos(Math.round(cx - box.ox), Math.round(cy - box.oy), box.w, box.h);
  winX = p.x; winY = p.y;
  orbCenter = { x: box.ox, y: box.oy };
  window.rd.setOverlayBounds({ x: winX, y: winY, width: box.w, height: box.h });
}
// Keep the window CENTRE (where the orb lives) on the current display, so the orb can
// never be dragged out of reach. The window may overhang an edge; the orb stays grabbable.
function clampPos(x, y, w, h) {
  const s = window.screen, m = 24;
  const sx = s.availLeft || 0, sy = s.availTop || 0, sw = s.availWidth, sh = s.availHeight;
  return {
    x: Math.max(sx + m - w / 2, Math.min(x, sx + sw - m - w / 2)),
    y: Math.max(sy + m - h / 2, Math.min(y, sy + sh - m - h / 2)),
  };
}

// re-layout keeping the orb's on-screen position fixed
function changeState(mutate, persist) {
  const anchor = { x: winX + orbCenter.x, y: winY + orbCenter.y };
  mutate();
  relayout(anchor, persist, true);
}

const OUT_MS = 340;   // match the expand (rd-in) duration so minimize feels the same speed
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let transToken = 0;

// ---------- edge-aware fit ----------
// Keep every button inside the screen work area when the orb is parked near an edge.
// The orb stays at its anchor; the BUTTON BLOCK bends to fit: radial -> a half/quarter
// pie pointed at the open space; grid -> relocated below/right/left/above the orb.
const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function workArea() {
  const s = window.screen;
  return { x: s.availLeft || 0, y: s.availTop || 0, w: s.availWidth, h: s.availHeight };
}
// build a window box that bounds the orb (centred at ox,oy) plus the given child screen
// rects, padded by PAD; returns the box origin + the orb offset within it.
function boxFrom(ox, oy, rects, padBelowOrb) {
  let l = ox - ORB_VIS, t = oy - ORB_VIS, r = ox + ORB_VIS, b = oy + ORB_VIS + (padBelowOrb || 0);
  for (const c of rects) { l = Math.min(l, c.l); t = Math.min(t, c.t); r = Math.max(r, c.r); b = Math.max(b, c.b); }
  l -= PAD; t -= PAD; r += PAD; b += PAD;
  const winX = Math.round(l), winY = Math.round(t);
  return { w: Math.round(r) - winX, h: Math.round(b) - winY, winX, winY, orbX: Math.round(ox) - winX, orbY: Math.round(oy) - winY };
}

// pick the arc (centre angle + sweep) for a radial layout given which edges are blocked.
// screen angles: 0 = right, +PI/2 = down, PI = left, -PI/2 = up.
function radialArc(bL, bR, bU, bD) {
  const PI = Math.PI, nb = (bL ? 1 : 0) + (bR ? 1 : 0) + (bU ? 1 : 0) + (bD ? 1 : 0);
  if (nb === 0) return { center: -PI / 2, sweep: 2 * PI, full: true };           // open everywhere -> full circle
  if (nb >= 3) { const center = !bR ? 0 : !bL ? PI : !bD ? PI / 2 : -PI / 2; return { center, sweep: PI / 2, full: false }; }
  if (nb === 1) { const center = bR ? PI : bL ? 0 : bD ? -PI / 2 : PI / 2; return { center, sweep: PI, full: false }; } // half pie
  // nb === 2
  if (bL && bR) return { center: bU ? PI / 2 : -PI / 2, sweep: PI / 2, full: false }; // pinched horizontally (rare)
  if (bU && bD) return { center: bL ? 0 : PI, sweep: PI / 2, full: false };           // pinched vertically (rare)
  return { center: Math.atan2(bD ? -1 : 1, bR ? -1 : 1), sweep: PI / 2, full: false }; // corner -> quarter pie toward the open diagonal
}

function fitRadial(lv, ox, oy) {
  const w = workArea();
  const R = cfg.overlay.radius || 120, bs = cfg.overlay.buttonSize || 54;
  const need = R + bs / 2 + 4;          // clearance from orb centre to keep a button on-screen in a direction
  const arc = radialArc(ox - w.x < need, (w.x + w.w) - ox < need, oy - w.y < need, (w.y + w.h) - oy < need);
  const n = lv.items.length, rects = [], angs = [];
  for (let i = 0; i < n; i++) {
    const a = arc.full ? (-Math.PI / 2 + (i / n) * Math.PI * 2)
                       : (n === 1 ? arc.center : arc.center - arc.sweep / 2 + (i / (n - 1)) * arc.sweep);
    angs.push(a);
    const cx = ox + R * Math.cos(a), cy = oy + R * Math.sin(a);
    rects.push({ l: cx - bs / 2, t: cy - bs / 2, r: cx + bs / 2, b: cy + bs / 2 });
  }
  const box = boxFrom(ox, oy, rects, ORBR / 2 + 18);   // reserve a little room below the orb for its label
  return { sz: { w: box.w, h: box.h, orbX: box.orbX, orbY: box.orbY, gridTop: 0, gridLeft: 0, angs }, x: box.winX, y: box.winY };
}

function fitGrid(lv, ox, oy) {
  const w = workArea();
  const cell = lv.cell, gap = lv.gap;
  const gw = lv.cols * cell + (lv.cols - 1) * gap;
  const gh = lv.rows * cell + (lv.rows - 1) * gap;
  const roomB = (w.y + w.h) - (oy + ORB_HALF), roomA = (oy - ORB_HALF) - w.y;
  const roomR = (w.x + w.w) - (ox + ORB_HALF), roomL = (ox - ORB_HALF) - w.x;
  // prefer below (the familiar layout); when it won't fit, slide to a side, then above.
  let dir;
  if (roomB >= gh + PAD) dir = 'down';
  else if (roomR >= gw + PAD) dir = 'right';
  else if (roomL >= gw + PAD) dir = 'left';
  else if (roomA >= gh + PAD) dir = 'up';
  else { const m = Math.max(roomB, roomR, roomL, roomA); dir = m === roomB ? 'down' : m === roomR ? 'right' : m === roomL ? 'left' : 'up'; }
  let gl, gt;
  if (dir === 'down' || dir === 'up') {
    gl = clampN(ox - gw / 2, w.x + PAD, Math.max(w.x + PAD, w.x + w.w - PAD - gw)); // centre on orb, then keep on-screen
    gt = dir === 'down' ? oy + ORB_HALF : oy - ORB_HALF - gh;
  } else {
    gt = clampN(oy - gh / 2, w.y + PAD, Math.max(w.y + PAD, w.y + w.h - PAD - gh));
    gl = dir === 'right' ? ox + ORB_HALF : ox - ORB_HALF - gw;
  }
  const box = boxFrom(ox, oy, [{ l: gl, t: gt, r: gl + gw, b: gt + gh }], 0);
  return { sz: { w: box.w, h: box.h, orbX: box.orbX, orbY: box.orbY, gridLeft: Math.round(gl - box.winX), gridTop: Math.round(gt - box.winY), cell, gap }, x: box.winX, y: box.winY };
}

// returns { sz, x, y } — the window geometry + origin with the orb pinned at `anchor`.
function computeFit(lv, anchor) {
  if (lv.renderMode === 'radial' || lv.renderMode === 'grid') {
    const wk = workArea();
    const ox = clampN(anchor.x, wk.x + EDGE_M, wk.x + wk.w - EDGE_M);
    const oy = clampN(anchor.y, wk.y + EDGE_M, wk.y + wk.h - EDGE_M);
    return lv.renderMode === 'radial' ? fitRadial(lv, ox, oy) : fitGrid(lv, ox, oy);
  }
  // collapsed / touchpad: keep the original centre-on-anchor placement (may overhang the edge)
  const sz = sizeFor(lv);
  const p = clampPos(Math.round(anchor.x - sz.orbX), Math.round(anchor.y - sz.orbY), sz.w, sz.h);
  return { sz, x: p.x, y: p.y };
}

// commit a computed fit: record geometry, render is the caller's job.
function commitFit(fit, persist) {
  winX = fit.x; winY = fit.y;
  orbCenter = { x: fit.sz.orbX, y: fit.sz.orbY };
  lastW = fit.sz.w; lastH = fit.sz.h;
  window.rd.setOverlayBounds({ x: winX, y: winY, width: fit.sz.w, height: fit.sz.h, persist: !!persist, collapsed });
}

function relayout(anchor, persist, animate) {
  const lv = level();
  const fit = computeFit(lv, anchor);
  if (!animate || reduceMotion) {
    render(lv, fit.sz);
    commitFit(fit, persist);
    return;
  }
  // Two-phase: collapse the current buttons (still inside the current, larger
  // window — nothing clips), THEN snap the window to the new size and spring the
  // new buttons in. The orb is pinned to `anchor` throughout, so the mid-flight
  // window resize is invisible (old buttons gone, new ones starting from scale 0).
  const token = ++transToken;
  const outKids = [...panel.children];
  orbPop();
  const finishIn = () => {
    if (token !== transToken) return;            // a newer transition superseded us
    render(lv, fit.sz);
    commitFit(fit, persist);
    [...panel.children].forEach((el, i) => { emanate(el, fit.sz.orbX, fit.sz.orbY); el.style.animationDelay = (i * 0.018) + 's'; el.classList.add('rd-in'); });
  };
  if (outKids.length) {
    outKids.forEach((el) => { emanate(el, orbCenter.x, orbCenter.y); el.style.pointerEvents = 'none'; el.classList.add('rd-out'); });
    setTimeout(finishIn, OUT_MS);
  } else {
    finishIn();                                  // nothing to dismiss (e.g. expanding from collapsed)
  }
}

// store on `el` the vector from its own centre back to the orb (parent) centre,
// so the keyframes can fly it out of / retract it into the parent button.
// Radial keys are positioned by their CENTRE (left/top + translate(-50%,-50%));
// grid keys by their top-left, so add half their box to find the centre.
function emanate(el, ox, oy) {
  const isKey = el.classList.contains('key');
  const cx = el.offsetLeft + (isKey ? 0 : el.offsetWidth / 2);
  const cy = el.offsetTop + (isKey ? 0 : el.offsetHeight / 2);
  el.style.setProperty('--rd-dx', (ox - cx) + 'px');
  el.style.setProperty('--rd-dy', (oy - cy) + 'px');
}

// Show the orb's layout/group label, then fade it out a couple seconds later.
// Re-poked on every state change and whenever the orb itself is touched.
let orbLabelTimer = null;
function pokeOrbLabel() {
  orbLabel.classList.remove('faded');
  clearTimeout(orbLabelTimer);
  orbLabelTimer = setTimeout(() => orbLabel.classList.add('faded'), 2000);
}

function orbPop() {
  orb.classList.remove('rd-pop');
  void orb.offsetWidth;                          // force reflow so the animation restarts every change
  orb.classList.add('rd-pop');
}

document.getElementById('btnEdit').addEventListener('click', () => window.rd.openEditor());
document.getElementById('btnHide').addEventListener('click', () => window.rd.hideOverlay());

// ---------- click-through ----------
// The window CAPTURES input by default (through=false) so touch/pen taps — which have
// NO hover phase — always land on the buttons. Only a real MOUSE physically hovering an
// empty gap flips the window to click-through, so clicks there fall to the app
// underneath; it flips straight back the instant the mouse moves onto a control, leaves
// the window, or simply goes idle. That idle-revert is what keeps a stray mouse hover
// from leaving the window stuck in click-through and swallowing the next touch tap.
let through = false;
let idleTimer = null;
function setThrough(v) { if (v === through) return; through = v; window.rd.setClickThrough(v); }
function capture() { clearTimeout(idleTimer); setThrough(false); }
const overInteractive = (x, y) => { const el = document.elementFromPoint(x, y); return !!(el && el.closest('.interactive')); };

window.addEventListener('pointermove', (e) => {
  if (drag || interacting > 0) { capture(); return; }
  if (e.pointerType === 'mouse' && !overInteractive(e.clientX, e.clientY)) {
    setThrough(true);                                                 // mouse over empty gap -> pass clicks through
    clearTimeout(idleTimer); idleTimer = setTimeout(capture, 450);    // mouse stopped (or it was a stylus hover) -> recapture
  } else {
    capture();                                                        // over a control, or any touch/pen move -> capture
  }
}, true);
// touch/pen presses arrive with no preceding hover move; guarantee we're capturing.
window.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'mouse' || overInteractive(e.clientX, e.clientY)) capture();
}, true);
window.addEventListener('pointerleave', capture, true);
window.addEventListener('blur', capture);

// ---------- helpers ----------
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function shade(hex, pct) {
  const c = (hex || '#5b8cff').replace('#', ''); if (c.length !== 6) return hex || '#5b8cff';
  const cl = (v) => Math.max(0, Math.min(255, Math.round(v)));
  let r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
  r = cl(r + pct / 100 * 255); g = cl(g + pct / 100 * 255); b = cl(b + pct / 100 * 255);
  return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// ---------- boot / live updates ----------
function boot(c) {
  cfg = c;
  active = Math.min(cfg.activeLayout || 0, cfg.layouts.length - 1);
  collapsed = !!cfg.overlay.collapsed;
  winX = window.screenX; winY = window.screenY;
  orbCenter = { x: 180, y: 180 }; // matches initial 360 window from main
  relayout({ x: winX + 180, y: winY + 180 }, false);
}
window.rd.onConfig((c) => {
  cfg = c;
  active = Math.min(cfg.activeLayout || 0, cfg.layouts.length - 1);
  relayout({ x: winX + orbCenter.x, y: winY + orbCenter.y }, false); // live editor updates, stay anchored
});
window.rd.getConfig().then(boot);
