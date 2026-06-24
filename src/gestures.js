'use strict';
// Global touch-gesture engine for RadialDeck — independent of the on-screen deck.
//
// A background raw-input host (PowerShell-hosted C#, normal integrity — gesture *detection*
// needs no uiAccess) registers the touch digitizer (HID usage 0x0D/0x04) on a plain hidden
// window with RIDEV_INPUTSINK, decodes ALL simultaneous contacts, and streams one line per
// input frame to stdout:  "F <tick> <cc> <id>,<x>,<y> <id>,<x>,<y> ..."  (active contacts only,
// coords already scaled to the virtualized screen space = Electron DIP space on this box).
//
// This module parses that stream, segments gestures (fingers down -> all up), classifies them
// (edge / swipe / tap / pinch / rotate / path) and recognizes free-form path shapes + custom
// templates with a $P point-cloud matcher, then hands the matched binding to a callback.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ----------------------------------------------------------------------------
// $P point-cloud recognizer (Vatavu, Anthony & Wobbrock 2012), compact port.
// Order/ària-insensitive enough for a centroid path; used for built-in shapes + custom.
// ----------------------------------------------------------------------------
const NP = 32; // resample count

function pathLength(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return d;
}
function resample(points, n) {
  const pts = points.map((p) => ({ x: p.x, y: p.y }));
  const I = pathLength(pts) / (n - 1);
  let D = 0;
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (D + d >= I && d > 0) {
      const t = (I - D) / d;
      const nx = pts[i - 1].x + t * (pts[i].x - pts[i - 1].x);
      const ny = pts[i - 1].y + t * (pts[i].y - pts[i - 1].y);
      const np = { x: nx, y: ny };
      out.push(np);
      pts.splice(i, 0, np);
      D = 0;
    } else D += d;
  }
  while (out.length < n) out.push({ x: pts[pts.length - 1].x, y: pts[pts.length - 1].y });
  return out.slice(0, n);
}
function centroid(pts) {
  let x = 0, y = 0;
  for (const p of pts) { x += p.x; y += p.y; }
  return { x: x / pts.length, y: y / pts.length };
}
// Normalize a raw point list to a $P template: resample -> scale to unit box -> translate to origin.
function normalizeCloud(points) {
  if (!points || points.length < 2) return null;
  let pts = resample(points, NP);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  const s = Math.max(maxX - minX, maxY - minY) || 1;
  pts = pts.map((p) => ({ x: (p.x - minX) / s, y: (p.y - minY) / s }));
  const c = centroid(pts);
  return pts.map((p) => ({ x: p.x - c.x, y: p.y - c.y }));
}
function cloudDistance(pts, tmpl, start) {
  const n = pts.length;
  const matched = new Array(n).fill(false);
  let sum = 0;
  let i = start;
  do {
    let min = Infinity, idx = -1;
    for (let j = 0; j < n; j++) {
      if (matched[j]) continue;
      const d = Math.hypot(pts[i].x - tmpl[j].x, pts[i].y - tmpl[j].y);
      if (d < min) { min = d; idx = j; }
    }
    if (idx >= 0) { matched[idx] = true; }
    const weight = 1 - ((i - start + n) % n) / n;
    sum += weight * min;
    i = (i + 1) % n;
  } while (i !== start);
  return sum;
}
function greedyMatch(pts, tmpl) {
  const step = Math.max(1, Math.floor(Math.pow(NP, 0.5)));
  let min = Infinity;
  for (let i = 0; i < NP; i += step) {
    min = Math.min(min, cloudDistance(pts, tmpl, i), cloudDistance(tmpl, pts, i));
  }
  return min;
}
// Returns confidence 0..1 (higher = better) of `points` matching a normalized template.
function cloudScore(points, normTmpl) {
  const norm = normalizeCloud(points);
  if (!norm || !normTmpl) return 0;
  const d = greedyMatch(norm, normTmpl);
  return Math.max(0, 1 - d / (2 * Math.sqrt(2))); // half-diagonal of unit box is the rough max
}

// ---- built-in shape templates (idealized point lists, normalized once) ----
function makeShape(name) {
  const pts = [];
  const N = 64;
  if (name === 'circle') {
    for (let i = 0; i <= N; i++) { const a = (i / N) * Math.PI * 2; pts.push({ x: Math.cos(a), y: Math.sin(a) }); }
  } else if (name === 'half-circle') {
    for (let i = 0; i <= N; i++) { const a = (i / N) * Math.PI; pts.push({ x: Math.cos(a), y: Math.sin(a) }); }
  } else if (name === 's') {
    for (let i = 0; i <= N; i++) { const t = i / N; const a = t * Math.PI * 2; pts.push({ x: Math.sin(a), y: t * 2 - 1 }); }
  } else if (name === 's-side') {
    for (let i = 0; i <= N; i++) { const t = i / N; const a = t * Math.PI * 2; pts.push({ x: t * 2 - 1, y: Math.sin(a) }); }
  } else if (name === 'figure8') {
    for (let i = 0; i <= N; i++) { const a = (i / N) * Math.PI * 2; pts.push({ x: Math.sin(a * 2), y: Math.sin(a) }); }
  } else return null;
  return normalizeCloud(pts);
}
const BUILTIN_SHAPES = {};
for (const s of ['circle', 'half-circle', 's', 's-side', 'figure8']) BUILTIN_SHAPES[s] = makeShape(s);

// ----------------------------------------------------------------------------
// The raw-input host (PowerShell + embedded C#). Streams active contacts to stdout.
// NOTE: keep the embedded C# free of '$' and '${' so it survives both the PS double-quoted
// here-string and this JS template literal.
// ----------------------------------------------------------------------------
const HOST_SCRIPT = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public static class RDG {
  [StructLayout(LayoutKind.Sequential)] public struct RAWINPUTDEVICE { public ushort UsagePage; public ushort Usage; public uint Flags; public IntPtr Target; }
  [StructLayout(LayoutKind.Sequential)] public struct RAWINPUTHEADER { public uint Type; public uint Size; public IntPtr hDevice; public IntPtr wParam; }
  [StructLayout(LayoutKind.Sequential)] public struct WNDCLASS { public uint style; public IntPtr lpfnWndProc; public int cbClsExtra; public int cbWndExtra; public IntPtr hInstance; public IntPtr hIcon; public IntPtr hCursor; public IntPtr hbrBackground; [MarshalAs(UnmanagedType.LPWStr)] public string lpszMenuName; [MarshalAs(UnmanagedType.LPWStr)] public string lpszClassName; }
  [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int ptx; public int pty; }
  public delegate IntPtr WndProcDelegate(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", SetLastError=true)] static extern ushort RegisterClassW(ref WNDCLASS c);
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateWindowExW(uint exStyle, string cls, string name, uint style, int x,int y,int w,int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
  [DllImport("user32.dll")] static extern IntPtr DefWindowProcW(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern int GetMessageW(out MSG m, IntPtr h, uint a, uint b);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessageW(ref MSG m);
  [DllImport("user32.dll", SetLastError=true)] static extern bool RegisterRawInputDevices(RAWINPUTDEVICE[] d, uint num, uint size);
  [DllImport("user32.dll", SetLastError=true)] static extern uint GetRawInputData(IntPtr h, uint cmd, IntPtr data, ref uint size, uint hsize);
  [DllImport("user32.dll", SetLastError=true)] static extern uint GetRawInputDeviceInfoW(IntPtr h, uint cmd, IntPtr data, ref uint size);
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandleW(string n);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [StructLayout(LayoutKind.Sequential)] public struct HIDP_CAPS { public ushort Usage, UsagePage, InputReportByteLength, OutputReportByteLength, FeatureReportByteLength; [MarshalAs(UnmanagedType.ByValArray, SizeConst=17)] public ushort[] Reserved; public ushort NumberLinkCollectionNodes, NumberInputButtonCaps, NumberInputValueCaps, NumberInputDataIndices, NumberOutputButtonCaps, NumberOutputValueCaps, NumberOutputDataIndices, NumberFeatureButtonCaps, NumberFeatureValueCaps, NumberFeatureDataIndices; }
  [StructLayout(LayoutKind.Sequential)] public struct HIDP_VALUE_CAPS { public ushort UsagePage; public byte ReportID; public byte IsAlias; public ushort BitField; public ushort LinkCollection; public ushort LinkUsage; public ushort LinkUsagePage; public byte IsRange, IsStringRange, IsDesignatorRange, IsAbsolute, HasNull, Reserved; public ushort BitSize, ReportCount; [MarshalAs(UnmanagedType.ByValArray, SizeConst=5)] public ushort[] Reserved2; public uint UnitsExp, Units; public int LogicalMin, LogicalMax, PhysicalMin, PhysicalMax; public ushort U0,U1,S0,S1,D0,D1,DI0,DI1; }
  [DllImport("hid.dll")] static extern int HidP_GetCaps(IntPtr p, ref HIDP_CAPS c);
  [DllImport("hid.dll")] static extern int HidP_GetValueCaps(int rt, [Out] HIDP_VALUE_CAPS[] c, ref ushort len, IntPtr p);
  [DllImport("hid.dll")] static extern int HidP_GetUsageValue(int rt, ushort up, ushort lc, ushort u, ref uint v, IntPtr p, byte[] r, uint rl);
  [DllImport("hid.dll")] static extern int HidP_GetUsages(int rt, ushort up, ushort lc, [Out] ushort[] list, ref uint len, IntPtr p, byte[] r, uint rl);
  [DllImport("hid.dll")] static extern int HidP_MaxUsageListLength(int rt, ushort up, IntPtr p);
  const uint RID_INPUT=0x10000003, RIDI_PREPARSEDDATA=0x20000005; const int HidP_Input=0, OK=0x00110000; const uint WM_INPUT=0x00FF;
  static WndProcDelegate _proc; static int SW, SH;
  class Dev { public IntPtr pp; public List<ushort> lcs = new List<ushort>(); public int xMin,xMax,yMin,yMax; }
  static Dictionary<IntPtr,Dev> _devs = new Dictionary<IntPtr,Dev>();
  static Dev GetDev(IntPtr hDevice){
    Dev d; if(_devs.TryGetValue(hDevice, out d)) return d;
    uint sz=0; GetRawInputDeviceInfoW(hDevice, RIDI_PREPARSEDDATA, IntPtr.Zero, ref sz);
    if(sz==0){ _devs[hDevice]=null; return null; }
    IntPtr pp=Marshal.AllocHGlobal((int)sz); GetRawInputDeviceInfoW(hDevice, RIDI_PREPARSEDDATA, pp, ref sz);
    HIDP_CAPS caps=new HIDP_CAPS(); if(HidP_GetCaps(pp, ref caps)!=OK){ Marshal.FreeHGlobal(pp); _devs[hDevice]=null; return null; }
    ushort n=caps.NumberInputValueCaps; var vc=new HIDP_VALUE_CAPS[n];
    if(HidP_GetValueCaps(HidP_Input, vc, ref n, pp)!=OK){ Marshal.FreeHGlobal(pp); _devs[hDevice]=null; return null; }
    d=new Dev(); d.pp=pp; var xs=new Dictionary<ushort,int[]>(); var ys=new Dictionary<ushort,int[]>();
    for(int i=0;i<n;i++){ var c=vc[i]; ushort usage=c.U0;
      if(c.UsagePage==0x01 && usage==0x30){ if(!xs.ContainsKey(c.LinkCollection)){ xs[c.LinkCollection]=new int[]{c.LogicalMin,c.LogicalMax}; if(!d.lcs.Contains(c.LinkCollection)) d.lcs.Add(c.LinkCollection);} }
      if(c.UsagePage==0x01 && usage==0x31){ if(!ys.ContainsKey(c.LinkCollection)){ ys[c.LinkCollection]=new int[]{c.LogicalMin,c.LogicalMax};} } }
    foreach(var kv in xs){ d.xMin=kv.Value[0]; d.xMax=kv.Value[1]; break; }
    foreach(var kv in ys){ d.yMin=kv.Value[0]; d.yMax=kv.Value[1]; break; }
    _devs[hDevice]=d; return d;
  }
  static IntPtr WndProc(IntPtr h, uint msg, IntPtr w, IntPtr l){ if(msg==WM_INPUT){ try{ OnInput(l); }catch{} } return DefWindowProcW(h,msg,w,l); }
  static void OnInput(IntPtr hRawInput){
    uint size=0; GetRawInputData(hRawInput, RID_INPUT, IntPtr.Zero, ref size, (uint)Marshal.SizeOf(typeof(RAWINPUTHEADER)));
    if(size==0) return; IntPtr buf=Marshal.AllocHGlobal((int)size);
    try {
      uint got=GetRawInputData(hRawInput, RID_INPUT, buf, ref size, (uint)Marshal.SizeOf(typeof(RAWINPUTHEADER))); if(got!=size) return;
      var hdr=(RAWINPUTHEADER)Marshal.PtrToStructure(buf, typeof(RAWINPUTHEADER)); if(hdr.Type!=2) return;
      int hoff=Marshal.SizeOf(typeof(RAWINPUTHEADER)); int dwSizeHid=Marshal.ReadInt32(buf, hoff); int dwCount=Marshal.ReadInt32(buf, hoff+4); int dataOff=hoff+8;
      Dev d=GetDev(hdr.hDevice); if(d==null||d.lcs.Count==0||d.xMax<=0||d.yMax<=0) return;
      for(int r=0;r<dwCount;r++){
        byte[] report=new byte[dwSizeHid]; Marshal.Copy(IntPtr.Add(buf, dataOff+r*dwSizeHid), report, 0, dwSizeHid);
        uint cc=0; HidP_GetUsageValue(HidP_Input,0x0D,0,0x54, ref cc, d.pp, report,(uint)dwSizeHid);
        var sb=new StringBuilder(); int emitted=0;
        foreach(ushort lc in d.lcs){
          uint vx=0,vy=0,vid=0;
          int sx=HidP_GetUsageValue(HidP_Input,0x01,lc,0x30, ref vx, d.pp, report,(uint)dwSizeHid);
          int sy=HidP_GetUsageValue(HidP_Input,0x01,lc,0x31, ref vy, d.pp, report,(uint)dwSizeHid);
          HidP_GetUsageValue(HidP_Input,0x0D,lc,0x51, ref vid, d.pp, report,(uint)dwSizeHid);
          int tip=0; int maxu=HidP_MaxUsageListLength(HidP_Input,0x0D,d.pp);
          if(maxu>0){ var ul=new ushort[maxu]; uint ulen=(uint)maxu; if(HidP_GetUsages(HidP_Input,0x0D,lc,ul, ref ulen, d.pp, report,(uint)dwSizeHid)==OK){ for(uint k=0;k<ulen;k++) if(ul[k]==0x42){ tip=1; break; } } }
          if(tip==1 && sx==OK && sy==OK){
            int px=(int)((double)(vx-d.xMin)/(d.xMax-d.xMin)*SW); int py=(int)((double)(vy-d.yMin)/(d.yMax-d.yMin)*SH);
            sb.Append(" "+vid+","+px+","+py); emitted++;
          }
        }
        Console.Out.WriteLine("F "+Environment.TickCount+" "+cc+(emitted>0?sb.ToString():"")); Console.Out.Flush();
      }
    } finally { Marshal.FreeHGlobal(buf); }
  }
  static void OwnerWatch(){
    try { string s=Environment.GetEnvironmentVariable("RD_OWNER_PID"); if(string.IsNullOrEmpty(s)) return; int pid=int.Parse(s);
      var th=new System.Threading.Thread(()=>{ try{ System.Diagnostics.Process.GetProcessById(pid).WaitForExit(); }catch{} Environment.Exit(0); }); th.IsBackground=true; th.Start();
    } catch {}
  }
  public static void Run(){
    SW=GetSystemMetrics(0); SH=GetSystemMetrics(1);
    Console.Out.WriteLine("READY "+SW+" "+SH); Console.Out.Flush();
    OwnerWatch();
    _proc=new WndProcDelegate(WndProc);
    WNDCLASS wc=new WNDCLASS(); wc.lpfnWndProc=Marshal.GetFunctionPointerForDelegate(_proc); wc.hInstance=GetModuleHandleW(null); wc.lpszClassName="RDgSink"; RegisterClassW(ref wc);
    IntPtr hwnd=CreateWindowExW(0,"RDgSink","RDgSink",0x80000000u,0,0,0,0,IntPtr.Zero,IntPtr.Zero,wc.hInstance,IntPtr.Zero);
    var rid=new RAWINPUTDEVICE[1]; rid[0].UsagePage=0x0D; rid[0].Usage=0x04; rid[0].Flags=0x00000100; rid[0].Target=hwnd;
    RegisterRawInputDevices(rid, 1, (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICE)));
    MSG m; while(GetMessageW(out m, IntPtr.Zero, 0, 0)>0){ TranslateMessage(ref m); DispatchMessageW(ref m); }
  }
}
"@
[RDG]::Run()
`;

// ----------------------------------------------------------------------------
// Gestures engine
// ----------------------------------------------------------------------------
class Gestures {
  // opts: { getSettings(), getBindings(), onGesture(binding), log(msg) }
  constructor(opts) {
    this.opts = opts || {};
    this.proc = null;
    this.buf = '';
    this.screen = { w: 1920, h: 1080 };
    this.frames = [];        // current gesture: [{ t, pts: Map(id->{x,y}) }]
    this.active = false;     // a gesture is in progress
    this.lastFire = 0;
    this.idleTimer = null;
    this._record = null;     // { fingers, cb } when recording a custom template
    this._stopped = false;
  }

  log(m) { try { if (this.opts.log) this.opts.log(m); } catch {} }

  start() {
    if (this.proc) return;
    this._stopped = false;
    // Run the host from a temp .ps1 via -File. Delivering the big Add-Type here-string through
    // `-Command -` (stdin) mis-parses: the type defines but the trailing call never runs, so the
    // process exits 0 with no output. A locally written temp file carries no mark-of-the-web, so
    // RemoteSigned executes it without requiring a signature.
    if (!this._scriptPath) {
      try {
        this._scriptPath = path.join(os.tmpdir(), 'RadialDeck-gesture-host.ps1');
        fs.writeFileSync(this._scriptPath, HOST_SCRIPT, 'utf8');
      } catch (e) { this.log('host script write failed: ' + e); return; }
    }
    const env = Object.assign({}, process.env, { RD_OWNER_PID: String(process.pid) });
    let child;
    try {
      child = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', this._scriptPath],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env });
    } catch (e) { this.log('spawn failed: ' + e); return; }
    this.proc = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => this._onData(d));
    child.on('exit', () => {
      this.proc = null;
      if (!this._stopped) setTimeout(() => this.start(), 1200); // auto-respawn
    });
    this.log('gesture host started');
    // Engage always-on capture IMMEDIATELY if the setting is on; don't wait for first touch.
    try { if (this._settings && this._settings().captureMultiFinger) this._engageCapture(); } catch {}
  }

  stop() {
    this._stopped = true;
    this._releaseCapture(); // release touch + tear down renewer
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (this.proc) { try { this.proc.kill(); } catch {} this.proc = null; }
  }

  startRecording(fingers, cb) { this._record = { fingers: fingers || 0, cb }; }
  cancelRecording() { this._record = null; }

  // Capture mode (v2 — always-on + re-inject):
  // When captureMultiFinger is enabled, register the injector as the system pointer
  // input target IMMEDIATELY and keep it that way. The injector now re-injects 1-2
  // finger touches via InjectTouchInput so apps still receive normal touch, but it
  // drops 3+ finger frames so gestures don't leak to other apps. This also fixes
  // ghost/wrong-window touch routing because we control where every touch is delivered.
  // A 1s renewer keeps the injector's 2s watchdog from auto-releasing.
  _updateCapture(_count) {
    const on = !!this._settings().captureMultiFinger;
    if (on) this._engageCapture(); else this._releaseCapture();
  }
  _engageCapture() {
    if (this._capActive) return;
    this._capActive = true;
    this._sendCapture(true);
    if (this._capRenewer) clearInterval(this._capRenewer);
    this._capRenewer = setInterval(() => { if (this._capActive) this._sendCapture(true); }, 1000);
  }
  _releaseCapture() {
    if (this._capRenewer) { clearInterval(this._capRenewer); this._capRenewer = null; }
    if (!this._capActive) return;
    this._capActive = false;
    this._sendCapture(false);
  }
  _sendCapture(on) { try { if (this.opts.onCapture) this.opts.onCapture(on); } catch (e) { this.log('onCapture err ' + e); } }

  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (line) this._onLine(line);
    }
  }

  _onLine(line) {
    if (line.startsWith('READY')) {
      const p = line.split(/\s+/);
      if (p.length >= 3) { this.screen = { w: +p[1] || 1920, h: +p[2] || 1080 }; }
      this.log('gesture host ready ' + this.screen.w + 'x' + this.screen.h);
      return;
    }
    if (!line.startsWith('F ')) return;
    // F <tick> <cc> [id,x,y ...]
    const p = line.split(' ');
    const t = +p[1];
    const pts = new Map();
    for (let k = 3; k < p.length; k++) {
      const a = p[k].split(',');
      if (a.length === 3) pts.set(+a[0], { x: +a[1], y: +a[2] });
    }
    this._frame(t, pts);
  }

  _frame(t, pts) {
    this._updateCapture(pts.size);
    if (pts.size > 0) {
      this.active = true;
      this.frames.push({ t, pts });
      if (this.frames.length > 4000) this.frames.shift();
      if (this.idleTimer) { clearTimeout(this.idleTimer); }
      // safety: if the "all up" frame is ever dropped, end after a quiet gap
      this.idleTimer = setTimeout(() => this._end(), 120);
    } else if (this.active) {
      this.active = false;
      if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
      this._end();
    }
  }

  _end() {
    const frames = this.frames;
    this.frames = [];
    this.active = false;
    if (!frames.length) return;

    // recording mode: capture this stroke's centroid path as a custom template, regardless
    // of whether it matches any known classification. Runs BEFORE _analyze.
    if (this._record) {
      let maxF = 0;
      for (const f of frames) maxF = Math.max(maxF, f.pts.size);
      if (this._record.fingers === 0 || this._record.fingers === maxF) {
        const stable = frames.filter((f) => f.pts.size === maxF);
        const cp = stable.map((f) => centroid(Array.from(f.pts.values())));
        const tmpl = normalizeCloud(cp);
        const cb = this._record.cb; this._record = null;
        if (cb) cb({ points: tmpl, fingers: maxF, ok: !!tmpl });
        return;
      }
    }

    const g = this._analyze(frames);
    if (!g) return;

    const now = Date.now();
    const settings = this._settings();
    if (now - this.lastFire < (settings.cooldownMs || 350)) return;
    const binding = this._match(g);
    if (binding) {
      this.lastFire = now;
      this.log('gesture ' + g.kind + ' f=' + g.fingers + (g.dir ? ' ' + g.dir : '') + (g.shape ? ' ' + g.shape : '') + ' -> ' + (binding.name || binding.combo));
      try { if (this.opts.onGesture) this.opts.onGesture(binding, g); } catch (e) { this.log('onGesture err ' + e); }
    }
  }

  _settings() { try { return this.opts.getSettings() || {}; } catch { return {}; } }
  _bindings() { try { return this.opts.getBindings() || []; } catch { return []; } }

  // Turn a frame list into a classified gesture descriptor.
  _analyze(frames) {
    const S = this._settings();
    let maxF = 0;
    for (const f of frames) maxF = Math.max(maxF, f.pts.size);
    if (maxF === 0) return null;
    const stable = frames.filter((f) => f.pts.size === maxF);
    if (stable.length < 1) return null;

    const cen = (f) => centroid(Array.from(f.pts.values()));
    const centroidPath = stable.map(cen);
    const cS = centroidPath[0], cE = centroidPath[centroidPath.length - 1];
    const net = { x: cE.x - cS.x, y: cE.y - cS.y };
    const straightLen = Math.hypot(net.x, net.y);
    const pLen = pathLength(centroidPath) || 0.0001;
    const straightness = straightLen / pLen;
    const duration = stable[stable.length - 1].t - stable[0].t;

    // bbox of centroid path (movement magnitude for tap test)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of centroidPath) { minX = Math.min(minX, c.x); minY = Math.min(minY, c.y); maxX = Math.max(maxX, c.x); maxY = Math.max(maxY, c.y); }
    const moveMag = Math.max(maxX - minX, maxY - minY, straightLen);

    const g = { fingers: maxF, centroidPath, dir: null, shape: null, kind: null, duration };

    // ---- edge swipe (start near L/R screen edge, travel inward) ----
    const sf = stable[0];
    let nearestEdge = null;
    for (const pt of sf.pts.values()) {
      if (pt.x <= (S.edgeMarginPx || 28)) nearestEdge = 'left';
      else if (pt.x >= this.screen.w - (S.edgeMarginPx || 28)) nearestEdge = 'right';
    }
    if (nearestEdge && straightLen >= (S.minSwipePx || 110)) {
      if (nearestEdge === 'left' && net.x > 0) { g.kind = 'edge'; g.dir = 'left'; return g; }
      if (nearestEdge === 'right' && net.x < 0) { g.kind = 'edge'; g.dir = 'right'; return g; }
    }

    // ---- tap ----
    if (moveMag < (S.tapMaxPx || 30) && duration < (S.tapMaxMs || 320)) { g.kind = 'tap'; return g; }

    // ---- straight swipe ----
    if (straightLen >= (S.minSwipePx || 110) && straightness >= 0.80) {
      g.kind = 'swipe';
      g.dir = Math.abs(net.x) >= Math.abs(net.y) ? (net.x > 0 ? 'right' : 'left') : (net.y > 0 ? 'down' : 'up');
      return g;
    }

    // ---- pinch / rotate (need >=2 fingers; use shared contacts across stable span) ----
    if (maxF >= 2) {
      const Sf = stable[0], Ef = stable[stable.length - 1];
      const ids = [];
      for (const id of Sf.pts.keys()) if (Ef.pts.has(id)) ids.push(id);
      if (ids.length >= 2) {
        const csS = centroid(Array.from(Sf.pts.values()));
        const csE = centroid(Array.from(Ef.pts.values()));
        let ratioSum = 0, angSum = 0, cnt = 0;
        for (const id of ids) {
          const a = Sf.pts.get(id), b = Ef.pts.get(id);
          const rS = Math.hypot(a.x - csS.x, a.y - csS.y) || 0.001;
          const rE = Math.hypot(b.x - csE.x, b.y - csE.y) || 0.001;
          ratioSum += rE / rS;
          let dA = Math.atan2(b.y - csE.y, b.x - csE.x) - Math.atan2(a.y - csS.y, a.x - csS.x);
          while (dA > Math.PI) dA -= 2 * Math.PI;
          while (dA < -Math.PI) dA += 2 * Math.PI;
          angSum += dA; cnt++;
        }
        const ratio = ratioSum / cnt;
        const deg = Math.abs((angSum / cnt) * 180 / Math.PI);
        const pinchIn = S.pinchMinRatio || 0.72, pinchOut = 1 / pinchIn;
        // pinch wins if radius change dominates; else rotate if angle is big
        if ((ratio <= pinchIn || ratio >= pinchOut) && deg < (S.rotateMinDeg || 35)) {
          g.kind = 'pinch'; g.dir = ratio <= pinchIn ? 'in' : 'out'; return g;
        }
        if (deg >= (S.rotateMinDeg || 35)) {
          g.kind = 'rotate'; g.dir = (angSum / cnt) > 0 ? 'cw' : 'ccw'; return g; // screen y-down: +angle = clockwise
        }
      }
    }

    // ---- path shape (free-form) ----
    if (moveMag >= (S.minSwipePx || 110)) {
      const best = this._recognizePath(g.centroidPath, maxF);
      if (best && best.score >= (S.pathMinScore || 0.80)) {
        g.kind = best.custom ? 'custom' : 'path';
        g.shape = best.shape;       // built-in name
        g.templateId = best.id;     // custom binding id
        g.score = best.score;
        return g;
      }
    }
    return null;
  }

  // Match centroid path against built-in shapes + custom templates that have an ENABLED
  // binding for this finger count (keeps candidates tight -> fewer false positives).
  _recognizePath(path, fingers) {
    let best = null;
    for (const b of this._bindings()) {
      if (!b.enabled || b.fingers !== fingers) continue;
      if (b.kind === 'path' && b.shape && BUILTIN_SHAPES[b.shape]) {
        const s = cloudScore(path, BUILTIN_SHAPES[b.shape]);
        if (!best || s > best.score) best = { score: s, shape: b.shape, custom: false };
      } else if (b.kind === 'custom' && Array.isArray(b.points) && b.points.length) {
        const s = cloudScore(path, b.points);
        if (!best || s > best.score) best = { score: s, id: b.id, custom: true };
      }
    }
    return best;
  }

  // Find an enabled binding matching this gesture descriptor.
  _match(g) {
    for (const b of this._bindings()) {
      if (!b.enabled) continue;
      if (b.kind !== g.kind) continue;
      if (b.fingers !== g.fingers) continue;
      if (g.kind === 'tap') return b;
      if (g.kind === 'edge' || g.kind === 'swipe' || g.kind === 'pinch' || g.kind === 'rotate') {
        if (b.dir === g.dir) return b;
      }
      if (g.kind === 'path') { if (b.shape === g.shape) return b; }
      if (g.kind === 'custom') { if (b.id === g.templateId) return b; }
    }
    return null;
  }
}

module.exports = { Gestures, normalizeCloud, cloudScore, BUILTIN_SHAPES, HOST_SCRIPT };
