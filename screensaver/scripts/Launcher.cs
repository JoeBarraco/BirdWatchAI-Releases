// BirdWatchAI Community Feed — Launcher stub
// This tiny .scr lives in System32 so it appears in the Screen Saver dropdown.
// It reads the real Electron screensaver path from the registry and launches it,
// forwarding all command-line arguments (/s, /c, /p:HWND, etc.).
//
// The AssemblyTitle becomes the FileDescription in the PE version info,
// which is what Windows Screen Saver Settings displays in the dropdown.

using System;
using System.Diagnostics;
using System.Reflection;
using Microsoft.Win32;

[assembly: AssemblyTitle("BirdWatchAI Community Feed")]
[assembly: AssemblyDescription("BirdWatchAI Community Feed - community bird gallery screensaver")]
[assembly: AssemblyCompany("BirdWatchAI")]
[assembly: AssemblyProduct("BirdWatchAI Community Feed")]
[assembly: AssemblyVersion("1.2.1.0")]
[assembly: AssemblyFileVersion("1.2.1.0")]

class BirdWatchAIScreensaverLauncher
{
    static int Main(string[] args)
    {
        string scrPath = null;
        try
        {
            // Try HKLM first (written by the admin installer), fall back to HKCU
            using (var key = Registry.LocalMachine.OpenSubKey(@"Software\BirdWatchAI\Screensaver")
                          ?? Registry.CurrentUser.OpenSubKey(@"Software\BirdWatchAI\Screensaver"))
            {
                if (key != null)
                    scrPath = key.GetValue("Path") as string;
            }
        }
        catch { return 1; }

        if (string.IsNullOrEmpty(scrPath) || !System.IO.File.Exists(scrPath))
            return 1;

        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = scrPath,
                Arguments = string.Join(" ", args),
                UseShellExecute = false,
                WorkingDirectory = System.IO.Path.GetDirectoryName(scrPath),
            };

            var proc = Process.Start(psi);
            if (proc != null)
            {
                proc.WaitForExit();
                return proc.ExitCode;
            }
        }
        catch { }

        return 1;
    }
}
