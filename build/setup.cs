// RadialDeck self-contained setup bootstrapper.
// A single self-elevating .exe (requireAdministrator manifest) that embeds the whole app
// (payload.zip) + the UIAccess setup script. On run it stops any running instance, extracts
// the app into Program Files\RadialDeck, then runs uiaccess-setup.ps1 (creates/trusts the
// code-signing cert, signs the uiAccess helper, makes shortcuts). No external installer
// toolchain — avoids electron-builder's winCodeSign symlink/cloud-drive problems.

using System;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Diagnostics;

static class Setup
{
    static Stream Res(string name) { return Assembly.GetExecutingAssembly().GetManifestResourceStream(name); }

    static int Main()
    {
        try
        {
            string dest = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "RadialDeck");
            Console.WriteLine("RadialDeck Setup");
            Console.WriteLine("Installing to: " + dest);
            Console.WriteLine();

            Console.WriteLine("Stopping any running instance...");
            foreach (string n in new[] { "RadialDeck", "RadialDeckInput" })
                foreach (var p in Process.GetProcessesByName(n)) { try { p.Kill(); p.WaitForExit(3000); } catch { } }

            Directory.CreateDirectory(dest);

            Console.WriteLine("Extracting application files...");
            string tmp = Path.Combine(Path.GetTempPath(), "rd-payload-" + Guid.NewGuid().ToString("N") + ".zip");
            using (var s = Res("payload.zip")) using (var fo = File.Create(tmp)) s.CopyTo(fo);
            using (var za = ZipFile.OpenRead(tmp))
            {
                foreach (var e in za.Entries)
                {
                    string outPath = Path.Combine(dest, e.FullName.Replace('/', Path.DirectorySeparatorChar));
                    if (e.FullName.EndsWith("/")) { Directory.CreateDirectory(outPath); continue; }
                    Directory.CreateDirectory(Path.GetDirectoryName(outPath));
                    e.ExtractToFile(outPath, true);
                }
            }
            try { File.Delete(tmp); } catch { }

            string ps1 = Path.Combine(dest, "uiaccess-setup.ps1");
            using (var s = Res("uiaccess-setup.ps1")) using (var fo = File.Create(ps1)) s.CopyTo(fo);

            Console.WriteLine("Configuring UIAccess (signing the input helper) and creating shortcuts...");
            var psi = new ProcessStartInfo("powershell.exe",
                "-NoProfile -ExecutionPolicy RemoteSigned -File \"" + ps1 + "\" -InstallDir \"" + dest + "\"")
            { UseShellExecute = false };
            var pr = Process.Start(psi); pr.WaitForExit();

            Console.WriteLine();
            Console.WriteLine("Done. Launch RadialDeck from the Start Menu or Desktop shortcut.");
            Console.WriteLine("(It runs with UIAccess so it can drive elevated windows and capture multi-finger gestures.)");
            Console.WriteLine();
            Console.WriteLine("Press any key to close.");
            try { Console.ReadKey(); } catch { }
            return 0;
        }
        catch (Exception ex)
        {
            Console.WriteLine();
            Console.WriteLine("INSTALL FAILED: " + ex.Message);
            Console.WriteLine("Press any key to close.");
            try { Console.ReadKey(); } catch { }
            return 1;
        }
    }
}
