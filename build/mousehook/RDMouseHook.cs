// RDMouseHook.exe — right-button drag gesture capture for RadialDeck.
//
// ============================ WHY THERE IS NO HOOK HERE ============================
// This used to install a global WH_MOUSE_LL hook. That wedged the user's desktop THREE
// times, each needing a hard reboot. Do not reintroduce one.
//
// A low-level hook is a WAIT: win32k delivers the callout to the installing thread's message
// queue and BLOCKS the Raw Input Thread on a completion event. The RIT is the single
// desktop-wide thread that feeds every other thread's input queue, and it serialises mouse
// AND keyboard — so while it waits on us, nobody on the desktop gets any input at all. The
// only bound is LowLevelHooksTimeout (which on this machine had been set to 5000 ms, so a
// hiccup became a five-second-per-event freeze). Keeping that safe requires "no pause
// anywhere in this process, ever" — including GC, JIT, page faults and type loads. In .NET
// that invariant is unverifiable, and one violation freezes the machine.
//
// Raw Input is a POST: the RIT copies the packet into our buffer, posts WM_INPUT, and moves
// on immediately. It never waits for us, there is no timeout, and no callback into our code
// sits in the input delivery path. If we are slow, our own queue backs up and WE miss
// events — nobody else is affected. That is structural impossibility, not reduced odds.
//
// We only need to OBSERVE the right button (we suppress nothing and replay nothing), so a
// hook buys us exactly no capability while costing the whole desktop's responsiveness.
//
// Notes:
//   * RAWMOUSE.lLastX/lLastY are pre-ballistics RELATIVE deltas — never integrate them for a
//     screen path. GetCursorPos() gives the real, accelerated, multi-monitor cursor position.
//   * RIDEV_INPUTSINK means we receive input even when not foreground, which is what a
//     global gesture needs.
//   * Allocation and I/O here are harmless (we block nobody), but the steady path is still
//     kept allocation-light out of good manners.
//
// Protocol: one line per gesture on stdout:  MG x,y x,y x,y ...
// Lifetime: exits when its owner (pid in argv[0]) exits; Electron also puts it in a Job
// Object with KILL_ON_JOB_CLOSE, so the kernel reaps it even if Electron is force-killed.

using System;
using System.Runtime.InteropServices;
using System.Threading;

static class RDMouseHook
{
    const int MIN_PX = 24;          // below this it's a plain right-click, not a gesture
    const int MAX_PTS = 4096;
    const int DRAG_TIMEOUT_MS = 15000;

    // ---- Raw Input ----
    const int RIM_TYPEMOUSE = 0;
    const int RIDEV_INPUTSINK = 0x00000100;
    const int RID_INPUT = 0x10000003;
    const int WM_INPUT = 0x00FF;
    const ushort RI_MOUSE_RIGHT_BUTTON_DOWN = 0x0004;
    const ushort RI_MOUSE_RIGHT_BUTTON_UP = 0x0008;
    const uint HID_USAGE_PAGE_GENERIC = 0x01;
    const uint HID_USAGE_GENERIC_MOUSE = 0x02;

    [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
    [StructLayout(LayoutKind.Sequential)]
    struct RAWINPUTDEVICE { public ushort usUsagePage; public ushort usUsage; public uint dwFlags; public IntPtr hwndTarget; }
    [StructLayout(LayoutKind.Sequential)] struct WNDCLASS {
        public uint style; public IntPtr lpfnWndProc; public int cbClsExtra; public int cbWndExtra;
        public IntPtr hInstance; public IntPtr hIcon; public IntPtr hCursor; public IntPtr hbrBackground;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpszMenuName;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpszClassName;
    }
    [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr h; public uint m; public IntPtr w; public IntPtr l; public uint t; public int x; public int y; }
    delegate IntPtr WndProcDelegate(IntPtr h, uint msg, IntPtr w, IntPtr l);

    [DllImport("user32.dll", SetLastError = true)] static extern bool RegisterRawInputDevices(RAWINPUTDEVICE[] d, uint num, uint size);
    [DllImport("user32.dll", SetLastError = true)] static extern uint GetRawInputData(IntPtr hRawInput, uint cmd, IntPtr data, ref uint size, uint hdrSize);
    [DllImport("user32.dll", SetLastError = true)] static extern ushort RegisterClassW(ref WNDCLASS c);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateWindowExW(uint ex, string cls, string name, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr p);
    [DllImport("user32.dll")] static extern IntPtr DefWindowProcW(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern int GetMessageW(out MSG m, IntPtr h, uint a, uint b);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessageW(ref MSG m);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandleW(string n);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
    const uint SYNCHRONIZE = 0x00100000;
    const uint INFINITE = 0xFFFFFFFF;

    static readonly int[] _px = new int[MAX_PTS];
    static readonly int[] _py = new int[MAX_PTS];
    static int _n, _sx, _sy, _downAt;
    static bool _down, _moved;

    static WndProcDelegate _wndProc;           // rooted: a collected delegate faults the window
    static IntPtr _rawBuf = IntPtr.Zero;       // reused unmanaged buffer for GetRawInputData
    static uint _rawBufSize;

    // HWND_MESSAGE: a message-only window. Invisible, never activated, exists purely to
    // receive WM_INPUT.
    static readonly IntPtr HWND_MESSAGE = new IntPtr(-3);

    static void Emit()
    {
        int n = _n;
        if (n < 2) return;
        var sb = new System.Text.StringBuilder(n * 10 + 4);
        sb.Append("MG");
        for (int i = 0; i < n; i++) sb.Append(' ').Append(_px[i]).Append(',').Append(_py[i]);
        try { Console.Out.WriteLine(sb.ToString()); Console.Out.Flush(); } catch { }
    }

    static void OnRightDown()
    {
        POINT p; if (!GetCursorPos(out p)) return;
        _down = true; _moved = false; _sx = p.x; _sy = p.y;
        _downAt = Environment.TickCount;
        _px[0] = p.x; _py[0] = p.y; _n = 1;
    }

    static void OnMove()
    {
        if (!_down) return;
        POINT p; if (!GetCursorPos(out p)) return;
        if (Math.Abs(p.x - _sx) + Math.Abs(p.y - _sy) >= MIN_PX) _moved = true;
        int n = _n;
        if (n < MAX_PTS) { _px[n] = p.x; _py[n] = p.y; _n = n + 1; }
    }

    static void OnRightUp()
    {
        if (!_down) return;
        _down = false;
        // Deliberately do NOT synthesize Esc here. The right button was never consumed, so the
        // app shows its own context menu; RadialDeck decides what to do about that. Injecting
        // a blind Esc from here landed in the wrong window and cancelled unrelated things.
        if (_moved) Emit();
        _n = 0;
    }

    static IntPtr WndProc(IntPtr h, uint msg, IntPtr w, IntPtr l)
    {
        if (msg == WM_INPUT)
        {
            uint size = 0;
            // header size = sizeof(RAWINPUTHEADER) = 24 on x64
            if (GetRawInputData(l, RID_INPUT, IntPtr.Zero, ref size, 24) == 0 && size > 0)
            {
                if (size > _rawBufSize)
                {
                    if (_rawBuf != IntPtr.Zero) Marshal.FreeHGlobal(_rawBuf);
                    _rawBuf = Marshal.AllocHGlobal((int)size); _rawBufSize = size;
                }
                uint got = GetRawInputData(l, RID_INPUT, _rawBuf, ref size, 24);
                if (got == size)
                {
                    // RAWINPUTHEADER: dwType @0. RAWMOUSE begins @24 on x64:
                    //   usFlags @24, usButtonFlags @28, usButtonData @30, ulRawButtons @32,
                    //   lLastX @36, lLastY @40
                    int dwType = Marshal.ReadInt32(_rawBuf, 0);
                    if (dwType == RIM_TYPEMOUSE)
                    {
                        ushort btn = (ushort)Marshal.ReadInt16(_rawBuf, 28);
                        int dx = Marshal.ReadInt32(_rawBuf, 36);
                        int dy = Marshal.ReadInt32(_rawBuf, 40);
                        if ((btn & RI_MOUSE_RIGHT_BUTTON_DOWN) != 0) OnRightDown();
                        if ((dx != 0 || dy != 0)) OnMove();
                        if ((btn & RI_MOUSE_RIGHT_BUTTON_UP) != 0) OnRightUp();
                    }
                }
            }
            return DefWindowProcW(h, msg, w, l);
        }
        return DefWindowProcW(h, msg, w, l);
    }

    // Clears a drag that never saw its button-up (e.g. the button was released over a
    // secure desktop / UAC prompt, where we get no raw input).
    static void Watchdog()
    {
        while (true)
        {
            Thread.Sleep(1000);
            if (_down && Environment.TickCount - _downAt > DRAG_TIMEOUT_MS) { _down = false; _moved = false; _n = 0; }
        }
    }

    // OpenProcess+Wait rather than Process.GetProcessById: no managed Process object, and a
    // failure here must NOT kill us (that silently disabled gestures at startup before).
    static void WatchOwner(int pid)
    {
        IntPtr h = OpenProcess(SYNCHRONIZE, false, pid);
        if (h == IntPtr.Zero) return;               // can't watch -> just keep running
        WaitForSingleObject(h, INFINITE);
        CloseHandle(h);
        Environment.Exit(0);
    }

    static int Main(string[] args)
    {
        int ownerPid;
        if (args.Length >= 1 && int.TryParse(args[0], out ownerPid))
        { var w = new Thread(() => WatchOwner(ownerPid)); w.IsBackground = true; w.Start(); }

        var wd = new Thread(Watchdog); wd.IsBackground = true; wd.Start();

        _wndProc = WndProc;
        var wc = new WNDCLASS();
        wc.lpfnWndProc = Marshal.GetFunctionPointerForDelegate(_wndProc);
        wc.hInstance = GetModuleHandleW(null);
        wc.lpszClassName = "RDRawInputSink";
        if (RegisterClassW(ref wc) == 0)
        { Console.Error.WriteLine("CLASSFAIL " + Marshal.GetLastWin32Error()); return 1; }

        IntPtr hwnd = CreateWindowExW(0, "RDRawInputSink", "RDRawInputSink", 0, 0, 0, 0, 0,
            HWND_MESSAGE, IntPtr.Zero, wc.hInstance, IntPtr.Zero);
        if (hwnd == IntPtr.Zero)
        { Console.Error.WriteLine("WNDFAIL " + Marshal.GetLastWin32Error()); return 1; }

        var rid = new RAWINPUTDEVICE[1];
        rid[0].usUsagePage = (ushort)HID_USAGE_PAGE_GENERIC;
        rid[0].usUsage = (ushort)HID_USAGE_GENERIC_MOUSE;
        rid[0].dwFlags = RIDEV_INPUTSINK;          // receive even when not foreground
        rid[0].hwndTarget = hwnd;
        if (!RegisterRawInputDevices(rid, 1, (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICE))))
        { Console.Error.WriteLine("RAWFAIL " + Marshal.GetLastWin32Error()); return 1; }

        Console.Out.WriteLine("READY"); Console.Out.Flush();

        MSG m; int r;
        while ((r = GetMessageW(out m, IntPtr.Zero, 0, 0)) != 0)
        {
            if (r == -1) { Console.Error.WriteLine("PUMPFAIL " + Marshal.GetLastWin32Error()); return 2; }
            TranslateMessage(ref m); DispatchMessageW(ref m);
        }
        return 0;
    }
}
