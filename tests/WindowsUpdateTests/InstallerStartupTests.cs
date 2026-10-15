using System.Diagnostics;
using System.Text;
using PcMcp;

internal static class InstallerStartupTests
{
    internal static async Task Run(Func<string, Func<string, Task>, Task> test)
    {
        await test("installer waits for delayed readiness", async home =>
        {
            using var process = Start(home, "Start-Sleep -Milliseconds 700; [IO.File]::WriteAllText('installer.ready','ready'); Start-Sleep -Seconds 30");
            try { await InstallerStartup.WaitAsync(process, home, CancellationToken.None, TimeSpan.FromSeconds(10)); }
            finally { await Stop(process); }
        });
        await test("installer early exit reports its phase and exit code", async home =>
        {
            File.WriteAllText(Path.Combine(home, "installer-state.json"), "{\"phase\":\"verifying-download\",\"message\":\"fixture hash failure\"}");
            using var process = Start(home, "exit 17");
            try
            {
                await InstallerStartup.WaitAsync(process, home, CancellationToken.None, TimeSpan.FromSeconds(10));
                throw new Exception("Unexpected ready state");
            }
            catch (IOException error) when (error.Message.Contains("17") && error.Message.Contains("verifying-download")) { }
            finally { await Stop(process); }
        });
        await test("installer timeout keeps a bounded diagnostic and cancellation wins over ready", async home =>
        {
            File.WriteAllText(Path.Combine(home, "installer-state.json"), "{\"phase\":\"verifying-download\",\"message\":\"slow disk\"}");
            using var process = Start(home, "Start-Sleep -Seconds 30");
            try
            {
                try { await InstallerStartup.WaitAsync(process, home, CancellationToken.None, TimeSpan.FromMilliseconds(200)); throw new Exception("Timeout was ignored"); }
                catch (TimeoutException error) when (error.Message.Contains("slow disk")) { }
                File.WriteAllText(Path.Combine(home, "installer.ready"), "ready");
                using var cancelled = new CancellationTokenSource(); cancelled.Cancel();
                try { await InstallerStartup.WaitAsync(process, home, cancelled.Token); throw new Exception("Cancellation was ignored"); }
                catch (OperationCanceledException) { }
                File.WriteAllText(Path.Combine(home, "installer-state.json"), new string('x', 17000));
                if (InstallerStartup.Details(home).Length > 200) throw new Exception("Oversized diagnostics escaped the limit");
            }
            finally { await Stop(process); }
        });
        await test("embedded installer records bootstrap failures before handshake", async home =>
        {
            using var source = typeof(WindowsUpdates).Assembly.GetManifestResourceStream("PcMcp.update-install.ps1")!;
            using var reader = new StreamReader(source);
            await File.WriteAllTextAsync(Path.Combine(home, "install.ps1"), await reader.ReadToEndAsync());
            File.WriteAllText(Path.Combine(home, "plan.json"), "{broken");
            using var process = Start(home, "& './install.ps1' -Manifest './plan.json'");
            try
            {
                try { await InstallerStartup.WaitAsync(process, home, CancellationToken.None, TimeSpan.FromSeconds(10)); throw new Exception("Malformed manifest was accepted"); }
                catch (IOException error) when (error.Message.Contains("starting")) { }
                if (!File.Exists(Path.Combine(home, "installer-state.json"))) throw new Exception("Bootstrap failure has no diagnostic");
                if (File.Exists(Path.Combine(home, "installer.ready"))) throw new Exception("Bootstrap failure published readiness");
            }
            finally { await Stop(process); }
        });
    }

    private static Process Start(string home, string script)
    {
        var info = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe"))
        { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = home };
        foreach (var arg in new[] { "-NoProfile", "-NonInteractive", "-EncodedCommand", Convert.ToBase64String(Encoding.Unicode.GetBytes(script)) }) info.ArgumentList.Add(arg);
        return Process.Start(info) ?? throw new Exception("Cannot start fixture");
    }
    private static async Task Stop(Process process)
    { if (!process.HasExited) process.Kill(true); await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5)); }
}
