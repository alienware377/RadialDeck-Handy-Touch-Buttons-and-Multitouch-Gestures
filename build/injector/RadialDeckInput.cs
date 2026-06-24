// RadialDeckInput.exe — tiny uiAccess input injector for RadialDeck.
//
// Why this exists: a uiAccess-manifested Electron exe cannot render (Chromium can't
// spawn its renderer/GPU/network children under the uiAccess token). So RadialDeck.exe
// stays at NORMAL integrity and renders, and this tiny separate process carries the
// uiAccess privilege. It gets uiAccess from its OWN manifest (asInvoker + uiAccess=true)
// + Authenticode signature + living in Program Files. With uiAccess it can SendInput /
// keybd_event into higher-integrity (elevated/admin) windows that UIPI would otherwise block.
//
// Transport: a named pipe server (\\.\pipe\RadialDeckInput). RadialDeck (keyboard.js)
// connects as a client and writes the SAME line protocol the old inline PowerShell
// helper used, so behavior is identical:
//   D <vkHex> [ext]   key down            (ext=1 -> KEYEVENTF_EXTENDEDKEY)
//   U <vkHex> [ext]   key up
//   MV <dx> <dy>      relative cursor move (mouse_event MOVE)
//   MB <flag>         raw mouse_event button flag (decimal)
//   F <px> <py>       capture wheel target at a screen point (0 0 -> focused fg control)
//   W <delta>         vertical wheel   (120 = one notch)
//   H <delta>         horizontal wheel
//
// Lifetime: serves one client at a time; loops to accept reconnects. Exits when the
// owning RadialDeck process (passed as argv[0]) is gone, so it never orphans.

using System;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Threading;

static class Native
{
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
    [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO lpgui);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] public static extern bool RegisterTouchWindow(IntPtr hWnd, uint ulFlags);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc cb, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x, y; }
    [StructLayout(LayoutKind.Sequential)]
    public struct GUITHREADINFO
    {
        public int cbSize; public int flags;
        public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
        public RECT rcCaret;
    }

    // ---- capture window + pointer-input-target (capture mode) ----
    public delegate IntPtr WndProc(IntPtr h, uint m, IntPtr w, IntPtr l);
    [StructLayout(LayoutKind.Sequential)] public struct WNDCLASS { public uint style; public IntPtr lpfnWndProc; public int cbClsExtra; public int cbWndExtra; public IntPtr hInstance; public IntPtr hIcon; public IntPtr hCursor; public IntPtr hbrBackground; [MarshalAs(UnmanagedType.LPWStr)] public string lpszMenuName; [MarshalAs(UnmanagedType.LPWStr)] public string lpszClassName; }
    [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int ptx; public int pty; }
    [DllImport("user32.dll", SetLastError=true)] public static extern ushort RegisterClassW(ref WNDCLASS c);
    [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern IntPtr CreateWindowExW(uint ex, string cls, string name, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr p);
    [DllImport("user32.dll")] public static extern IntPtr DefWindowProcW(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern int GetMessageW(out MSG m, IntPtr h, uint a, uint b);
    [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG m);
    [DllImport("user32.dll")] public static extern IntPtr DispatchMessageW(ref MSG m);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern IntPtr SetTimer(IntPtr h, IntPtr id, uint ms, IntPtr cb);
    [DllImport("user32.dll")] public static extern bool KillTimer(IntPtr h, IntPtr id);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr GetModuleHandleW(string n);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool RegisterPointerInputTarget(IntPtr h, int type);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool UnregisterPointerInputTarget(IntPtr h, int type);

    // ---- touch injection (InjectTouchInput) — always-on capture + re-injection mode ----
    [DllImport("user32.dll", SetLastError=true)] public static extern bool InitializeTouchInjection(uint maxCount, uint dwMode);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool InjectTouchInput(uint count, [In] POINTER_TOUCH_INFO[] contacts);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool GetPointerType(uint pointerId, out uint pointerType);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool GetPointerFrameTouchInfo(uint pointerId, ref uint count, [Out] POINTER_TOUCH_INFO[] touchInfos);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINTER_INFO {
        public uint pointerType;
        public uint pointerId;
        public uint frameId;
        public uint pointerFlags;
        public IntPtr sourceDevice;
        public IntPtr hwndTarget;
        public POINT ptPixelLocation;
        public POINT ptHimetricLocation;
        public POINT ptPixelLocationRaw;
        public POINT ptHimetricLocationRaw;
        public uint dwTime;
        public uint historyCount;
        public int  InputData;
        public uint dwKeyStates;
        public ulong PerformanceCount;
        public uint ButtonChangeType;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct POINTER_TOUCH_INFO {
        public POINTER_INFO pointerInfo;
        public uint  touchFlags;
        public uint  touchMask;
        public RECT  rcContact;
        public RECT  rcContactRaw;
        public uint  orientation;
        public uint  pressure;
    }
}

static class Program
{
    const string PIPE = "RadialDeckInput";
    const uint MOUSEEVENTF_MOVE   = 0x0001;
    const uint MOUSEEVENTF_WHEEL  = 0x0800;
    const uint MOUSEEVENTF_HWHEEL = 0x1000;
    const uint KEYEVENTF_KEYUP    = 0x0002;

    // wheel target captured by the most recent 'F' command
    static IntPtr _target = IntPtr.Zero;
    static int _tx = 0, _ty = 0;

    // ---- capture mode v2: ALWAYS-ON capture + selective re-injection ----
    // When capture mode is enabled (CAP 1), the hidden window registers as the system
    // pointer-input target for PT_TOUCH PERMANENTLY (not just during 3+ finger gestures).
    // For each WM_POINTER frame we count active non-injected contacts:
    //   - count < 3: re-inject via InjectTouchInput so the app underneath still receives
    //     the touch (preserves 1-2 finger interaction; routes to whatever window is
    //     actually under the contact point — fixes "jumpy scroll to ghost monitor").
    //   - count >= 3: drop (the gesture host handles these as gestures).
    // We filter POINTER_FLAG_INJECTED to avoid an infinite re-inject loop.
    // Slot map: OS pointer IDs are mapped to injection slots 0..MAX_SLOTS-1 because
    // InjectTouchInput requires pointerId values in [0, MAX_SLOTS).
    // SAFETY: a 2-second watchdog still auto-releases the registration if "CAP 1"
    // renewals stop; killing this process (owner-pid watch) also frees it immediately.
    const int  PT_TOUCH = 2;
    const uint PT_TOUCH_PT = 2;
    const uint TOUCH_FEEDBACK_INDIRECT = 0x00000002;  // no on-screen ripple for injected touches
    const uint WM_TIMER = 0x0113;
    const uint WM_CAP_ON  = 0x8001;   // WM_APP+1
    const uint WM_CAP_OFF = 0x8002;   // WM_APP+2
    const uint WM_POINTER_FIRST = 0x0245, WM_POINTER_LAST = 0x0257;
    const int  MAX_SLOTS = 10;

    // POINTER_FLAG_*
    const uint PF_NEW       = 0x00000001;
    const uint PF_INRANGE   = 0x00000002;
    const uint PF_INCONTACT = 0x00000004;
    const uint PF_INJECTED  = 0x00000020;
    const uint PF_DOWN      = 0x00010000;
    const uint PF_UPDATE    = 0x00020000;
    const uint PF_UP        = 0x00040000;

    static IntPtr _capHwnd = IntPtr.Zero;
    static bool _captured = false;
    static bool _injectInitialized = false;
    static Native.WndProc _capProc;

    // per-OS-pointer state: slot index + "policy" decided when the pointer went down.
    // Once a pointer is decided as PASSTHROUGH (inject) we keep injecting it until it
    // lifts, even if more fingers join (would otherwise leave the target app with a
    // stuck pointer). Same the other way: a pointer started in DROP stays dropped.
    class Slot { public byte injectId; public bool passthrough; public int x; public int y; }
    static readonly System.Collections.Generic.Dictionary<uint, Slot> _slots
        = new System.Collections.Generic.Dictionary<uint, Slot>();
    static readonly bool[] _slotInUse = new bool[MAX_SLOTS];

    static byte AllocSlot()
    {
        for (byte i = 0; i < MAX_SLOTS; i++) if (!_slotInUse[i]) { _slotInUse[i] = true; return i; }
        return 0; // overflow — reuse 0 (rare; 10 simultaneous fingers)
    }
    static void FreeSlot(byte i) { if (i < MAX_SLOTS) _slotInUse[i] = false; }

    static void StartCaptureWindow()
    {
        var t = new Thread(() =>
        {
            _capProc = CapProc; // keep delegate alive
            var wc = new Native.WNDCLASS();
            wc.lpfnWndProc = Marshal.GetFunctionPointerForDelegate(_capProc);
            wc.hInstance = Native.GetModuleHandleW(null);
            wc.lpszClassName = "RDCapSink";
            Native.RegisterClassW(ref wc);
            _capHwnd = Native.CreateWindowExW(0, "RDCapSink", "RDCapSink", 0x80000000u, 0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, wc.hInstance, IntPtr.Zero);
            Native.MSG m;
            while (Native.GetMessageW(out m, IntPtr.Zero, 0, 0) > 0) { Native.TranslateMessage(ref m); Native.DispatchMessageW(ref m); }
        });
        t.IsBackground = true;
        try { t.SetApartmentState(ApartmentState.STA); } catch { }
        t.Start();
    }

    static IntPtr CapProc(IntPtr h, uint msg, IntPtr w, IntPtr l)
    {
        if (msg == WM_CAP_ON)
        {
            if (!_injectInitialized)
            {
                // initialize once; survives across CAP toggles
                if (Native.InitializeTouchInjection(MAX_SLOTS, TOUCH_FEEDBACK_INDIRECT))
                { _injectInitialized = true; Log("touch injection initialized"); }
                else
                { Log("InitializeTouchInjection FAILED err=" + Marshal.GetLastWin32Error()); }
            }
            if (!_captured && Native.RegisterPointerInputTarget(h, PT_TOUCH))
            { _captured = true; Log("capture ON (always-on + reinject)"); }
            Native.SetTimer(h, (IntPtr)1, 2000, IntPtr.Zero); // re-arm 2s watchdog on each renew
            return IntPtr.Zero;
        }
        if (msg == WM_CAP_OFF || msg == WM_TIMER)
        {
            if (_captured) { Native.UnregisterPointerInputTarget(h, PT_TOUCH); _captured = false; Log(msg == WM_TIMER ? "capture auto-release" : "capture OFF"); }
            Native.KillTimer(h, (IntPtr)1);
            // drop any stale slot state — fresh start next time
            _slots.Clear();
            for (int i = 0; i < MAX_SLOTS; i++) _slotInUse[i] = false;
            return IntPtr.Zero;
        }

        if (msg >= WM_POINTER_FIRST && msg <= WM_POINTER_LAST)
        {
            HandlePointerFrame((uint)(w.ToInt64() & 0xFFFF));
            return IntPtr.Zero;
        }
        return Native.DefWindowProcW(h, msg, w, l);
    }

    static void HandlePointerFrame(uint pointerId)
    {
        try
        {
            // Pull the whole frame (all simultaneous contacts grouped under this pointerId).
            uint count = 0;
            Native.GetPointerFrameTouchInfo(pointerId, ref count, null);
            if (count == 0) return;
            var frame = new Native.POINTER_TOUCH_INFO[count];
            if (!Native.GetPointerFrameTouchInfo(pointerId, ref count, frame)) return;

            // Filter out our own re-injected pointers so we don't loop forever.
            int physN = 0;
            for (int i = 0; i < count; i++)
                if ((frame[i].pointerInfo.pointerFlags & PF_INJECTED) == 0) physN++;
            if (physN == 0) return;

            // Count current active non-injected contacts overall to decide whether new
            // pointers should be passthrough or dropped. (Existing pointers retain their
            // original decision so we never strand an injected pointer mid-touch.)
            int activeAll = 0;
            for (int i = 0; i < count; i++)
            {
                var pi = frame[i].pointerInfo;
                if ((pi.pointerFlags & PF_INJECTED) != 0) continue;
                if ((pi.pointerFlags & PF_UP) != 0) continue;  // about to lift
                activeAll++;
            }

            // Build re-injection batch
            var batch = new System.Collections.Generic.List<Native.POINTER_TOUCH_INFO>(physN);

            for (int i = 0; i < count; i++)
            {
                var src = frame[i];
                if ((src.pointerInfo.pointerFlags & PF_INJECTED) != 0) continue;

                uint osId = src.pointerInfo.pointerId;
                uint flags = src.pointerInfo.pointerFlags;
                bool isNew = (flags & PF_NEW) != 0;
                bool isUp  = (flags & PF_UP) != 0;

                Slot slot;
                if (isNew || !_slots.TryGetValue(osId, out slot))
                {
                    // New pointer — decide policy now
                    bool passthrough = (activeAll < 3);
                    slot = new Slot {
                        injectId = passthrough ? AllocSlot() : (byte)255,
                        passthrough = passthrough,
                        x = src.pointerInfo.ptPixelLocation.x,
                        y = src.pointerInfo.ptPixelLocation.y,
                    };
                    _slots[osId] = slot;
                }
                slot.x = src.pointerInfo.ptPixelLocation.x;
                slot.y = src.pointerInfo.ptPixelLocation.y;

                if (slot.passthrough)
                {
                    var pti = new Native.POINTER_TOUCH_INFO();
                    pti.pointerInfo.pointerType = PT_TOUCH_PT;
                    pti.pointerInfo.pointerId = slot.injectId;
                    pti.pointerInfo.ptPixelLocation = src.pointerInfo.ptPixelLocation;
                    if (isUp)
                        pti.pointerInfo.pointerFlags = PF_UP;
                    else if (isNew)
                        pti.pointerInfo.pointerFlags = PF_INRANGE | PF_INCONTACT | PF_DOWN;
                    else
                        pti.pointerInfo.pointerFlags = PF_INRANGE | PF_INCONTACT | PF_UPDATE;
                    pti.touchFlags = 0;
                    pti.touchMask = 0;
                    batch.Add(pti);
                }

                if (isUp)
                {
                    if (slot.passthrough) FreeSlot(slot.injectId);
                    _slots.Remove(osId);
                }
            }

            if (batch.Count > 0)
            {
                var arr = batch.ToArray();
                if (!Native.InjectTouchInput((uint)arr.Length, arr))
                    Log("InjectTouchInput failed n=" + arr.Length + " err=" + Marshal.GetLastWin32Error());
            }
        }
        catch (Exception ex) { Log("frame error: " + ex.Message); }
    }

    static int Main(string[] args)
    {
        // single instance: if another injector already serves the pipe, exit quietly.
        bool createdNew;
        using (var mutex = new Mutex(true, "RadialDeckInputSingleton", out createdNew))
        {
            if (!createdNew) return 0;

            // optional: exit when the owning RadialDeck pid dies (argv[0] = pid)
            if (args.Length >= 1)
            {
                int ownerPid;
                if (int.TryParse(args[0], out ownerPid))
                    StartOwnerWatch(ownerPid);
            }

            StartCaptureWindow(); // hidden window for capture-mode pointer-input target

            while (true)
            {
                try
                {
                    // InOut (duplex), NOT In-only: a PipeDirection.In server is created
                    // PIPE_ACCESS_INBOUND, but Node's net.connect opens the client duplex
                    // (GENERIC_READ|WRITE). Against an inbound-only pipe that handshake makes
                    // the connection drop the instant it opens -> the client sees connect-then-
                    // close ~1/sec and respawns its PS stopgap forever. Duplex lets the Node
                    // client stay connected; we still only ever read.
                    using (var server = new NamedPipeServerStream(
                        PIPE, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.None))
                    {
                        server.WaitForConnection();
                        Log("client connected");
                        using (var reader = new StreamReader(server))
                        {
                            string line;
                            while ((line = reader.ReadLine()) != null)
                            {
                                try { Handle(line); } catch { /* keep serving */ }
                            }
                        }
                        Log("client disconnected");
                    }
                }
                catch
                {
                    Thread.Sleep(200); // pipe error -> brief pause, then re-accept
                }
            }
        }
    }

    // minimal diagnostic log next to %TEMP%\RadialDeckInput.log — proves whether the Node
    // client actually connects to the uiAccess injector (vs. silently sitting on PS).
    static void Log(string msg)
    {
        try
        {
            string p = Path.Combine(Path.GetTempPath(), "RadialDeckInput.log");
            File.AppendAllText(p, DateTime.Now.ToString("HH:mm:ss.fff") + "  " + msg + Environment.NewLine);
        }
        catch { }
    }

    static void StartOwnerWatch(int pid)
    {
        var t = new Thread(() =>
        {
            try
            {
                var p = System.Diagnostics.Process.GetProcessById(pid);
                p.WaitForExit();
            }
            catch { /* already gone */ }
            Environment.Exit(0);
        });
        t.IsBackground = true;
        t.Start();
    }

    static int ToInt(string s) { return int.Parse(s, CultureInfo.InvariantCulture); }

    static void Handle(string line)
    {
        if (string.IsNullOrEmpty(line)) return;
        var p = line.Split(' ');
        if (p.Length < 2) return;
        string cmd = p[0];

        if (cmd == "CAP")
        {
            if (_capHwnd != IntPtr.Zero)
                Native.PostMessageW(_capHwnd, p[1] == "1" ? WM_CAP_ON : WM_CAP_OFF, IntPtr.Zero, IntPtr.Zero);
            return;
        }

        if (cmd == "F")
        {
            int px = ToInt(p[1]);
            int py = p.Length >= 3 ? ToInt(p[2]) : 0;
            if (px != 0 || py != 0)
            {
                var pt = new Native.POINT { x = px, y = py };
                IntPtr w = Native.WindowFromPoint(pt);
                _target = w != IntPtr.Zero ? w : Native.GetForegroundWindow();
                _tx = px; _ty = py;
            }
            else
            {
                IntPtr fg = Native.GetForegroundWindow();
                _target = fg;
                uint tid = Native.GetWindowThreadProcessId(fg, IntPtr.Zero);
                var gti = new Native.GUITHREADINFO();
                gti.cbSize = Marshal.SizeOf(gti);
                if (Native.GetGUIThreadInfo(tid, ref gti) && gti.hwndFocus != IntPtr.Zero)
                    _target = gti.hwndFocus;
                Native.RECT r;
                if (Native.GetWindowRect(_target, out r)) { _tx = (r.left + r.right) / 2; _ty = (r.top + r.bottom) / 2; }
                else { _tx = 0; _ty = 0; }
            }
            return;
        }

        if (cmd == "RTW")
        {
            // Register the overlay HWND as a touch window: routes physical touch to raw
            // WM_TOUCH (consumed by Chromium) and DISABLES Windows' legacy touch->mouse
            // promotion + pan/flick gesture engine for it. Without this, touching our
            // non-activating (WS_EX_NOACTIVATE) overlay warps the OS cursor to the contact
            // point and pans whatever window is under the cursor. flags=0 (TWF default).
            // IMPORTANT: Electron delivers physical touch to a CHILD render-widget HWND
            // (Chrome_RenderWidgetHostHWND), not the top-level window. Registering only the
            // top-level kills cursor promotion but leaves the gesture/pan engine live on the
            // child -> one-finger drag still pans the window under the cursor. So register
            // the whole HWND subtree (top-level + every descendant).
            IntPtr hwnd = new IntPtr(Convert.ToInt64(p[1], 16));
            uint flags = p.Length >= 3 ? (uint)ToInt(p[2]) : 0u;
            Native.RegisterTouchWindow(hwnd, flags);
            Native.EnumChildWindows(hwnd, (h, l) => { Native.RegisterTouchWindow(h, flags); return true; }, IntPtr.Zero);
            return;
        }

        if (cmd == "MV")
        {
            // ABSOLUTE move (GetCursorPos + SetCursorPos), NOT relative mouse_event.
            // Relative MOUSEEVENTF_MOVE is mangled by the pointer-speed slider and
            // "Enhance pointer precision" acceleration -> a fast finger flick teleports
            // the cursor "all over the place". SetCursorPos moves exactly dx/dy pixels.
            int dx = ToInt(p[1]), dy = ToInt(p[2]);
            Native.POINT cur;
            if (Native.GetCursorPos(out cur)) Native.SetCursorPos(cur.x + dx, cur.y + dy);
            return;
        }
        if (cmd == "MB") { Native.mouse_event((uint)ToInt(p[1]), 0, 0, 0, UIntPtr.Zero); return; }

        if (cmd == "W" || cmd == "H")
        {
            int delta = ToInt(p[1]);
            uint f = cmd == "H" ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL;
            if (_target != IntPtr.Zero && (_tx != 0 || _ty != 0))
            {
                Native.POINT old; bool have = Native.GetCursorPos(out old);
                Native.SetCursorPos(_tx, _ty);
                Native.mouse_event(f, 0, 0, delta, UIntPtr.Zero);
                if (have) Native.SetCursorPos(old.x, old.y);
            }
            else
            {
                Native.mouse_event(f, 0, 0, delta, UIntPtr.Zero);
            }
            return;
        }

        if (cmd == "D" || cmd == "U")
        {
            byte vk = (byte)Convert.ToInt32(p[1], 16);
            uint ext = (p.Length >= 3 && p[2] == "1") ? 1u : 0u;
            if (cmd == "D") Native.keybd_event(vk, 0, ext, UIntPtr.Zero);
            else Native.keybd_event(vk, 0, ext | KEYEVENTF_KEYUP, UIntPtr.Zero);
            return;
        }
    }
}
