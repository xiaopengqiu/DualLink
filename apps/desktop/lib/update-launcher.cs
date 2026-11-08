using System;
using System.Diagnostics;
using System.IO;

// A GUI-subsystem process survives the Electron/libuv job closing without opening
// a console. All replacement and rollback operations remain in the PS worker.
internal static class UpdateLauncher
{
    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length != 2 || !Path.IsPathRooted(args[0]) || !Path.IsPathRooted(args[1])) return 2;
            string script = Path.GetFullPath(args[0]);
            string config = Path.GetFullPath(args[1]);
            if (!String.Equals(Path.GetDirectoryName(script), Path.GetDirectoryName(config), StringComparison.OrdinalIgnoreCase)) return 2;
            if (!File.Exists(script) || !File.Exists(config) || script.IndexOf('"') >= 0 || config.IndexOf('"') >= 0) return 2;
            string powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
            ProcessStartInfo start = new ProcessStartInfo();
            start.FileName = powershell;
            start.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + script + "\" -ConfigPath \"" + config + "\"";
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.WindowStyle = ProcessWindowStyle.Hidden;
            start.WorkingDirectory = Path.GetDirectoryName(script);
            using (Process worker = Process.Start(start))
            {
                worker.WaitForExit();
                return worker.ExitCode;
            }
        }
        catch { return 1; }
    }
}
