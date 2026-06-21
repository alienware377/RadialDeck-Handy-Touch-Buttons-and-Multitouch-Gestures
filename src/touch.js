'use strict';
// Global touchscreen position tracker.
//
// Why this exists: when you touch a *pointer-aware* app directly on the
// touchscreen (Chromium/Electron, most modern apps), Windows routes the contact
// to the app as a pointer event and does NOT move the OS mouse cursor. So our
// getCursorScreenPoint() poll in main.js — which catches the physical mouse and
// the touchpad's synthetic cursor — never sees a direct screen touch.
//
// The only reliable way to know WHERE on screen a finger last touched, app-wide,
// even when our overlay is click-through / unfocused, is to register the touch
// digitizer as a Raw Input sink (RIDEV_INPUTSINK) and decode the HID contact
// report. We run a dedicated PowerShell process that hosts a message-only window,
// receives WM_INPUT, parses X (Generic-Desktop usage 0x30) / Y (0x31) via HidP,
// scales them to screen pixels, and prints "T x y" lines we read here.
//
// Coordinate space note: this helper process is DPI-unaware (like keyboard.js's),
// so GetSystemMetrics returns the virtualized 1920x1080-style space which equals
// Electron's DIP space (screen.getCursorScreenPoint) on this machine — the points
// it emits drop straight into the same coordinate system with no conversion.
// (Primary-monitor digitizer assumed; a second-monitor touchscreen would need the
// per-monitor mapping added.)

const { spawn } = require('child_process');

const TOUCH_HELPER = `
$ErrorActionPreference='Stop'
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class RT {
  public delegate IntPtr WndProcDelegate(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  public struct RAWINPUTDEVICE { public ushort UsagePage; public ushort Usage; public uint Flags; public IntPtr hwndTarget; }
  [StructLayout(LayoutKind.Sequential)]
  public struct RAWINPUTHEADER { public uint dwType; public uint dwSize; public IntPtr hDevice; public IntPtr wParam; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct WNDCLASS {
    public uint style; public WndProcDelegate lpfnWndProc; public int cbClsExtra; public int cbWndExtra;
    public IntPtr hInstance; public IntPtr hIcon; public IntPtr hCursor; public IntPtr hbrBackground;
    [MarshalAs(UnmanagedType.LPWStr)] public string lpszMenuName;
    [MarshalAs(UnmanagedType.LPWStr)] public string lpszClassName;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int ptX; public int ptY; }
  [StructLayout(LayoutKind.Sequential)]
  public struct HIDP_CAPS {
    public ushort Usage; public ushort UsagePage;
    public ushort InputReportByteLength; public ushort OutputReportByteLength; public ushort FeatureReportByteLength;
    [MarshalAs(UnmanagedType.ByValArray, SizeConst=17)] public ushort[] Reserved;
    public ushort NumberLinkCollectionNodes; public ushort NumberInputButtonCaps; public ushort NumberInputValueCaps;
    public ushort NumberInputDataIndices; public ushort NumberOutputButtonCaps; public ushort NumberOutputValueCaps;
    public ushort NumberOutputDataIndices; public ushort NumberFeatureButtonCaps; public ushort NumberFeatureValueCaps;
    public ushort NumberFeatureDataIndices;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct HIDP_VALUE_CAPS {
    public ushort UsagePage; public byte ReportID; public byte IsAlias; public ushort BitField;
    public ushort LinkCollection; public ushort LinkUsage; public ushort LinkUsagePage;
    public byte IsRange; public byte IsStringRange; public byte IsDesignatorRange; public byte IsAbsolute; public byte HasNull; public byte Reserved;
    public ushort BitSize; public ushort ReportCount;
    public ushort R2a; public ushort R2b; public ushort R2c; public ushort R2d; public ushort R2e;
    public uint UnitsExp; public uint Units;
    public int LogicalMin; public int LogicalMax; public int PhysicalMin; public int PhysicalMax;
    public ushort Usage; public ushort Reserved1; public ushort StringIndex; public ushort Reserved2;
    public ushort DesignatorIndex; public ushort Reserved3; public ushort DataIndex; public ushort Reserved4;
  }

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool RegisterRawInputDevices(RAWINPUTDEVICE[] d, uint num, uint size);
  [DllImport("user32.dll")]
  public static extern uint GetRawInputData(IntPtr h, uint cmd, IntPtr pData, ref uint size, uint hdrSize);
  [DllImport("user32.dll")]
  public static extern uint GetRawInputDeviceInfo(IntPtr h, uint cmd, IntPtr pData, ref uint size);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern ushort RegisterClassW(ref WNDCLASS c);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern IntPtr CreateWindowExW(uint exStyle, string cls, string name, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
  [DllImport("user32.dll")]
  public static extern IntPtr DefWindowProcW(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")]
  public static extern int GetMessageW(out MSG msg, IntPtr h, uint min, uint max);
  [DllImport("user32.dll")]
  public static extern bool TranslateMessage(ref MSG msg);
  [DllImport("user32.dll")]
  public static extern IntPtr DispatchMessageW(ref MSG msg);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)]
  public static extern IntPtr GetModuleHandleW(string name);
  [DllImport("user32.dll")]
  public static extern int GetSystemMetrics(int n);
  [DllImport("hid.dll")]
  public static extern int HidP_GetCaps(IntPtr pre, ref HIDP_CAPS caps);
  [DllImport("hid.dll")]
  public static extern int HidP_GetValueCaps(int type, [In,Out] HIDP_VALUE_CAPS[] caps, ref ushort len, IntPtr pre);
  [DllImport("hid.dll")]
  public static extern int HidP_GetUsageValue(int type, ushort usagePage, ushort link, ushort usage, out uint val, IntPtr pre, IntPtr report, uint reportLen);

  const uint RID_INPUT = 0x10000003;
  const uint RIDI_PREPARSEDDATA = 0x20000005;
  const uint RIDEV_INPUTSINK = 0x00000100;
  const uint WM_INPUT = 0x00FF;
  const int HIDP_INPUT = 0;
  const int HIDP_SUCCESS = 0x00110000;

  static WndProcDelegate _proc;
  static Dictionary<IntPtr, IntPtr> _pre = new Dictionary<IntPtr, IntPtr>();
  static Dictionary<IntPtr, int[]> _caps = new Dictionary<IntPtr, int[]>();
  static int _sw, _sh;

  static IntPtr WndProc(IntPtr h, uint msg, IntPtr w, IntPtr l) {
    if (msg == WM_INPUT) { try { Handle(l); } catch {} }
    return DefWindowProcW(h, msg, w, l);
  }

  static void Handle(IntPtr hRawInput) {
    uint size = 0;
    uint hdrSz = (uint)Marshal.SizeOf(typeof(RAWINPUTHEADER));
    GetRawInputData(hRawInput, RID_INPUT, IntPtr.Zero, ref size, hdrSz);
    if (size == 0) return;
    IntPtr buf = Marshal.AllocHGlobal((int)size);
    try {
      uint got = GetRawInputData(hRawInput, RID_INPUT, buf, ref size, hdrSz);
      if (got != size) return;
      RAWINPUTHEADER hdr = (RAWINPUTHEADER)Marshal.PtrToStructure(buf, typeof(RAWINPUTHEADER));
      if (hdr.dwType != 2) return; // RIM_TYPEHID
      int off = (int)hdrSz;
      uint dwSizeHid = (uint)Marshal.ReadInt32(buf, off);
      uint dwCount = (uint)Marshal.ReadInt32(buf, off + 4);
      if (dwCount == 0 || dwSizeHid == 0) return;
      IntPtr report = (IntPtr)(buf.ToInt64() + off + 8);

      IntPtr pre = GetPre(hdr.hDevice);
      if (pre == IntPtr.Zero) return;
      int[] c = GetCaps(hdr.hDevice, pre);
      if (c == null) return;

      uint vx, vy;
      int rx = HidP_GetUsageValue(HIDP_INPUT, 0x01, 0, 0x30, out vx, pre, report, dwSizeHid);
      int ry = HidP_GetUsageValue(HIDP_INPUT, 0x01, 0, 0x31, out vy, pre, report, dwSizeHid);
      if (rx != HIDP_SUCCESS || ry != HIDP_SUCCESS) return;
      double fx = (double)((int)vx - c[0]) / (double)(c[1] - c[0]);
      double fy = (double)((int)vy - c[2]) / (double)(c[3] - c[2]);
      if (fx < 0) fx = 0; if (fx > 1) fx = 1; if (fy < 0) fy = 0; if (fy > 1) fy = 1;
      int px = (int)Math.Round(fx * (_sw - 1));
      int py = (int)Math.Round(fy * (_sh - 1));
      Console.Out.Write("T " + px + " " + py + "\\n");
      Console.Out.Flush();
    } finally { Marshal.FreeHGlobal(buf); }
  }

  static IntPtr GetPre(IntPtr dev) {
    IntPtr p;
    if (_pre.TryGetValue(dev, out p)) return p;
    uint size = 0;
    GetRawInputDeviceInfo(dev, RIDI_PREPARSEDDATA, IntPtr.Zero, ref size);
    if (size == 0) { _pre[dev] = IntPtr.Zero; return IntPtr.Zero; }
    IntPtr buf = Marshal.AllocHGlobal((int)size);
    GetRawInputDeviceInfo(dev, RIDI_PREPARSEDDATA, buf, ref size);
    _pre[dev] = buf;
    return buf;
  }

  static int[] GetCaps(IntPtr dev, IntPtr pre) {
    int[] c;
    if (_caps.TryGetValue(dev, out c)) return c;
    HIDP_CAPS caps = new HIDP_CAPS();
    if (HidP_GetCaps(pre, ref caps) != HIDP_SUCCESS) { _caps[dev] = null; return null; }
    ushort n = caps.NumberInputValueCaps;
    if (n == 0) { _caps[dev] = null; return null; }
    HIDP_VALUE_CAPS[] vc = new HIDP_VALUE_CAPS[n];
    ushort len = n;
    if (HidP_GetValueCaps(HIDP_INPUT, vc, ref len, pre) != HIDP_SUCCESS) { _caps[dev] = null; return null; }
    int xMin=0,xMax=0,yMin=0,yMax=0; bool hx=false, hy=false;
    for (int i=0;i<len;i++) {
      if (vc[i].UsagePage == 0x01 && vc[i].Usage == 0x30) { xMin=vc[i].LogicalMin; xMax=vc[i].LogicalMax; hx=true; }
      else if (vc[i].UsagePage == 0x01 && vc[i].Usage == 0x31) { yMin=vc[i].LogicalMin; yMax=vc[i].LogicalMax; hy=true; }
    }
    if (!hx || !hy || xMax<=xMin || yMax<=yMin) { _caps[dev] = null; return null; }
    c = new int[]{xMin,xMax,yMin,yMax};
    _caps[dev] = c;
    return c;
  }

  public static void Run() {
    _sw = GetSystemMetrics(0); _sh = GetSystemMetrics(1);
    _proc = new WndProcDelegate(WndProc);
    WNDCLASS wc = new WNDCLASS();
    wc.lpfnWndProc = _proc;
    wc.hInstance = GetModuleHandleW(null);
    wc.lpszClassName = "RDTouchSink";
    RegisterClassW(ref wc);
    // A normal top-level window left unshown (WS_POPUP, 0x0 size, never ShowWindow'd).
    // We deliberately avoid HWND_MESSAGE: message-only windows can miss RIDEV_INPUTSINK
    // WM_INPUT delivery on some Windows builds, which would silently kill touch tracking.
    IntPtr hwnd = CreateWindowExW(0, "RDTouchSink", "RDTouchSink", 0x80000000, 0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, wc.hInstance, IntPtr.Zero);
    RAWINPUTDEVICE[] rid = new RAWINPUTDEVICE[1];
    rid[0].UsagePage = 0x0D; rid[0].Usage = 0x04; rid[0].Flags = RIDEV_INPUTSINK; rid[0].hwndTarget = hwnd;
    RegisterRawInputDevices(rid, 1, (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICE)));
    MSG msg;
    while (GetMessageW(out msg, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref msg); DispatchMessageW(ref msg); }
  }
}
"@
[RT]::Run()
`;

class TouchTracker {
  // onTouch(x, y, time): called for every contact report so the caller can filter
  // (e.g. drop touches that land on the deck) and keep its own "last app touch".
  constructor(onTouch) {
    this.last = null;     // { x, y } screen point (DIP) of the most recent touch
    this.lastTime = 0;    // Date.now() of that touch
    this.onTouch = typeof onTouch === 'function' ? onTouch : null;
    this.proc = null;
    this._buf = '';
    this._start();
  }

  _start() {
    this.proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
      { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }
    );
    this.proc.stdin.write(TOUCH_HELPER + '\n');
    this.proc.stdin.end();
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => this._onData(d));
    this.proc.on('exit', () => { this.proc = null; setTimeout(() => this._start(), 1000); });
  }

  _onData(d) {
    this._buf += d;
    let i;
    while ((i = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, i).trim();
      this._buf = this._buf.slice(i + 1);
      if (!line) continue;
      const m = line.split(' ');
      if (m[0] === 'T' && m.length === 3) {
        const x = parseInt(m[1], 10), y = parseInt(m[2], 10);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          const t = Date.now();
          this.last = { x, y }; this.lastTime = t;
          if (this.onTouch) this.onTouch(x, y, t);
        }
      }
    }
  }

  dispose() {
    if (this.proc) {
      try { this.proc.stdin.end(); } catch {}
      try { this.proc.kill(); } catch {}
      this.proc = null;
    }
  }
}

module.exports = { TouchTracker };
