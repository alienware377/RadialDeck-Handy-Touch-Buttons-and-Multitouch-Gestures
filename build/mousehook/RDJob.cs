// RDJob.exe — launches RDMouseHook.exe inside a Job Object with KILL_ON_JOB_CLOSE, then
// relays its stdout.
//
// Why: the gesture helper must NEVER outlive RadialDeck. An owner-pid watch is cooperative —
// it does nothing if the helper is wedged, and nothing at all if RadialDeck is force-killed.
// A Job Object is enforced by the kernel: when the last handle to the job closes (which
// happens automatically when THIS process dies, however it dies), Windows terminates every
// process in the job. Since this launcher is itself a child of RadialDeck and dies with it,
// the chain is: RadialDeck dies -> RDJob dies -> job handle closes -> hook helper is reaped.
// No cooperation, no cleanup code, no orphan.
//
// This process does no input work at all; it just pipes lines through.

using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

static class RDJob
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr sec, string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint len);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);

    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags, MinimumWorkingSetSize, MaximumWorkingSetSize, ActiveProcessLimit;
        public IntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS { public ulong r, w, o, rt, wt, ot; }
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    static int Main(string[] argv)
    {
        if (argv.Length < 1) { Console.Error.WriteLine("usage: RDJob <exe> [args...]"); return 2; }

        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job != IntPtr.Zero)
        {
            var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int len = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr p = Marshal.AllocHGlobal(len);
            try { Marshal.StructureToPtr(info, p, false); SetInformationJobObject(job, JobObjectExtendedLimitInformation, p, (uint)len); }
            finally { Marshal.FreeHGlobal(p); }
        }

        var psi = new ProcessStartInfo(argv[0]);
        for (int i = 1; i < argv.Length; i++) psi.Arguments += (i > 1 ? " " : "") + argv[i];
        psi.UseShellExecute = false; psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true; psi.RedirectStandardError = true;

        Process child;
        try { child = Process.Start(psi); }
        catch (Exception e) { Console.Error.WriteLine("SPAWNFAIL " + e.Message); return 3; }

        try { if (job != IntPtr.Zero) AssignProcessToJobObject(job, child.Handle); } catch { }

        child.ErrorDataReceived += (s, e) => { if (e.Data != null) { try { Console.Error.WriteLine(e.Data); } catch { } } };
        child.BeginErrorReadLine();

        string line;
        try { while ((line = child.StandardOutput.ReadLine()) != null) { Console.Out.WriteLine(line); Console.Out.Flush(); } }
        catch { }

        try { child.WaitForExit(); return child.ExitCode; } catch { return 0; }
    }
}
