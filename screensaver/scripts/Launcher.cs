// BirdWatchAI Screensaver — Launcher stub
// This tiny .scr lives in System32 so it appears in the Screen Saver dropdown.
// It reads the real Electron screensaver path from the registry and launches it,
// forwarding all command-line arguments (/s, /c, /p:HWND, etc.).

using System;
using System.Diagnostics;
using Microsoft.Win32;

class BirdWatchAIScreensaverLauncher
{
    static int Main(string[] args)
    {
        string scrPath = null;
        try
        {
            using (var key = Registry.CurrentUser.OpenSubKey(@"Software\BirdWatchAI\Screensaver"))
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
