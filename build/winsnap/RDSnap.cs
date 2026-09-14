// RDSnap.exe — prints a JSON snapshot of the foreground window so RadialDeck can remember
// what a "close & remember" gesture is about to close, and reopen it later.
//
// Output (one line): {"exe":"...","pid":123,"title":"...","kind":"explorer|browser|file|app","target":"..."}
//   explorer -> target is the folder path (read from the Shell window's LocationURL, exact)
//   browser  -> target empty; reopening is done with the browser's own Ctrl+Shift+T
//   file     -> target is a file path recovered from the window title
//   app      -> nothing recoverable; reopening just relaunches the exe
//
// Deliberately tiny and short-lived: run it, read one line, it exits. No hooks, no state.

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;

static class RDSnap
{
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

    static readonly string[] BROWSERS = { "chrome", "msedge", "firefox", "brave", "opera", "vivaldi", "arc" };

    static string J(string s)
    {
        if (s == null) return "";
        var sb = new StringBuilder();
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c < 32) sb.Append(' ');
            else sb.Append(c);
        }
        return sb.ToString();
    }

    // Ask the Shell for the folder this Explorer window is showing. Late-bound COM so we
    // don't need an interop assembly at build time.
    static string ExplorerPath(IntPtr hwnd)
    {
        try
        {
            Type t = Type.GetTypeFromProgID("Shell.Application");
            object shell = Activator.CreateInstance(t);
            object windows = t.InvokeMember("Windows", BindingFlags.InvokeMethod, null, shell, null);
            Type wt = windows.GetType();
            int count = (int)wt.InvokeMember("Count", BindingFlags.GetProperty, null, windows, null);
            for (int i = 0; i < count; i++)
            {
                object w = wt.InvokeMember("Item", BindingFlags.InvokeMethod, null, windows, new object[] { i });
                if (w == null) continue;
                Type it = w.GetType();
                long h = Convert.ToInt64(it.InvokeMember("HWND", BindingFlags.GetProperty, null, w, null));
                if (h != hwnd.ToInt64()) continue;
                string url = (string)it.InvokeMember("LocationURL", BindingFlags.GetProperty, null, w, null);
                if (!string.IsNullOrEmpty(url))
                {
                    try { return new Uri(url).LocalPath; } catch { return url; }
                }
                // Desktop / This PC have no URL — fall back to the display name
                return (string)it.InvokeMember("LocationName", BindingFlags.GetProperty, null, w, null);
            }
        }
        catch { }
        return "";
    }

    // Many editors/viewers put the document in the title. Pull out anything that looks like
    // a real existing path; otherwise a bare filename we can try to resolve later.
    static string PathFromTitle(string title)
    {
        if (string.IsNullOrEmpty(title)) return "";
        foreach (string part in title.Split(new[] { " - ", " — ", " | " }, StringSplitOptions.RemoveEmptyEntries))
        {
            string p = part.Trim().Trim('*', ' ');
            if (p.Length > 3 && (p[1] == ':' || p.StartsWith("\\\\")))
            {
                if (File.Exists(p) || Directory.Exists(p)) return p;
            }
        }
        return "";
    }

    static int Main()
    {
        IntPtr h = GetForegroundWindow();
        var sb = new StringBuilder(512);
        GetWindowTextW(h, sb, 512);
        string title = sb.ToString();
        uint pid; GetWindowThreadProcessId(h, out pid);

        string exe = "", name = "";
        try { var p = Process.GetProcessById((int)pid); name = p.ProcessName; exe = p.MainModule.FileName; } catch { }

        string kind = "app", target = "";
        string lname = name.ToLowerInvariant();
        if (lname == "explorer") { kind = "explorer"; target = ExplorerPath(h); }
        else if (Array.IndexOf(BROWSERS, lname) >= 0) { kind = "browser"; }
        else
        {
            string p = PathFromTitle(title);
            if (p.Length > 0) { kind = "file"; target = p; }
        }

        Console.Out.WriteLine("{\"exe\":\"" + J(exe) + "\",\"pid\":" + pid + ",\"title\":\"" + J(title) +
            "\",\"kind\":\"" + kind + "\",\"target\":\"" + J(target) + "\"}");
        return 0;
    }
}
