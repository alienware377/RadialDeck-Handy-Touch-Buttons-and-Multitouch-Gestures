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
