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
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
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
}

static class Program
{
    const string PIPE = "RadialDeckInput";
    const uint MOUSEEVENTF_MOVE     = 0x0001;
    const uint MOUSEEVENTF_WHEEL    = 0x0800;
    const uint MOUSEEVENTF_HWHEEL   = 0x1000;
    const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
    const uint KEYEVENTF_KEYUP      = 0x0002;
    // GetSystemMetrics indices for the virtual desktop (all monitors)
    const int SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77, SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79;

    // wheel target captured by the most recent 'F' command
    static IntPtr _target = IntPtr.Zero;
    static int _tx = 0, _ty = 0;

    // ---- capture mode: globally claim touch so 3+ finger gestures don't reach apps ----
    // A hidden window registers as the system pointer-input target for PT_TOUCH while a
    // 3+ finger gesture is in progress, so redirected touch is swallowed here instead of
    // reaching the foreground app. The gesture host (via Node) sends "CAP 1" on engage and
    // "CAP 0" on release. SAFETY: a 1.5s watchdog timer auto-releases if renews stop (host
    // crash / lost release), so touch can never get stuck captured. Killing this process
    // (owner-pid watch) also frees the registration immediately.
    const int PT_TOUCH = 2;
    const uint WM_TIMER = 0x0113;
    const uint WM_CAP_ON = 0x8001;   // WM_APP+1
    const uint WM_CAP_OFF = 0x8002;  // WM_APP+2
    const uint WM_POINTER_FIRST = 0x0245, WM_POINTER_LAST = 0x0257;
    static IntPtr _capHwnd = IntPtr.Zero;
    static bool _captured = false;
    static Native.WndProc _capProc;

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
            if (!_captured && Native.RegisterPointerInputTarget(h, PT_TOUCH)) { _captured = true; Log("capture ON"); }
            Native.SetTimer(h, (IntPtr)1, 1500, IntPtr.Zero); // (re)arm watchdog
            return IntPtr.Zero;
        }
        if (msg == WM_CAP_OFF || msg == WM_TIMER)
        {
            if (_captured) { Native.UnregisterPointerInputTarget(h, PT_TOUCH); _captured = false; Log(msg == WM_TIMER ? "capture auto-release" : "capture OFF"); }
            Native.KillTimer(h, (IntPtr)1);
            return IntPtr.Zero;
        }
        if (msg >= WM_POINTER_FIRST && msg <= WM_POINTER_LAST) return IntPtr.Zero; // swallow redirected touch
        return Native.DefWindowProcW(h, msg, w, l);
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
            // Move by dx/dy pixels using an ABSOLUTE injected mouse-move (SendInput-class via
            // mouse_event with MOUSEEVENTF_ABSOLUTE|VIRTUALDESK). Two reasons over SetCursorPos:
            //  1. Absolute (not relative) so it's NOT mangled by the pointer-speed slider /
            //     "Enhance pointer precision" — a fast flick won't teleport the cursor around.
            //  2. Unlike SetCursorPos (which just teleports the pointer), this emits a REAL
            //     mouse-move INPUT event. Apps that build a drag from the input stream — text
            //     selection in Windows Terminal/PowerShell, canvas drags, etc. — need genuine
            //     move events between button-down and button-up; SetCursorPos moves don't count,
            //     so click-and-drag silently failed in those apps.
            int dx = ToInt(p[1]), dy = ToInt(p[2]);
            Native.POINT cur;
            if (!Native.GetCursorPos(out cur)) return;
            int tx = cur.x + dx, ty = cur.y + dy;
            int vx = Native.GetSystemMetrics(SM_XVIRTUALSCREEN), vy = Native.GetSystemMetrics(SM_YVIRTUALSCREEN);
            int vw = Native.GetSystemMetrics(SM_CXVIRTUALSCREEN), vh = Native.GetSystemMetrics(SM_CYVIRTUALSCREEN);
            if (vw <= 1 || vh <= 1) { Native.SetCursorPos(tx, ty); return; } // fallback
            if (tx < vx) tx = vx; else if (tx > vx + vw - 1) tx = vx + vw - 1;
            if (ty < vy) ty = vy; else if (ty > vy + vh - 1) ty = vy + vh - 1;
            int nx = (int)(((long)(tx - vx) * 65535) / (vw - 1));
            int ny = (int)(((long)(ty - vy) * 65535) / (vh - 1));
            Native.mouse_event(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, nx, ny, 0, UIntPtr.Zero);
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
