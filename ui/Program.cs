using System.Diagnostics;
using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace PcMcp;

internal static class Program
{
    internal static AppLayout Layout { get; private set; } = null!;
    internal static string ProjectDir => Layout.Project;
    internal static string DataDir => Layout.Data;
    internal static readonly Uri UiUri = new("https://tmcp.local/index.html");
    internal static readonly bool Preview = !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("PC_MCP_UI_DATA_DIR"));
    internal static string Instance => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(DataDir.ToUpperInvariant())))[..16];
    internal static bool LocalOnly { get; private set; }
    internal static bool Headless { get; private set; }
    internal static uint ShowMessage { get; private set; }
    internal static readonly Icon AppIcon = LoadIcon();
    private static readonly SemaphoreSlim ServiceActions = new(1, 1);

    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        _ = CultureInfo.GetCultureInfo(1049);
        bool background;
        try
        {
            Layout = new AppLayout(args, Preview);
            background = args.Contains("--background") || (!args.Contains("--show") && Layout.StartMinimized());
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "TMCP: не удалось запустить приложение", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Environment.ExitCode = 1; return;
        }
        LocalOnly = args.Contains("--local") || Environment.GetEnvironmentVariable("MCP_LOCAL_ONLY") == "true";
        Headless = args.Contains("--headless");
        ShowMessage = Native.RegisterWindowMessage("TMCP.Show." + Instance);
        using var single = new Mutex(true, @"Local\TmcpDesktop-" + Instance, out var first);
        if (!first) { if (!Headless && !args.Contains("--autostart") && !args.Contains("--prepare-only")) Native.PostMessage(new IntPtr(0xffff), ShowMessage, IntPtr.Zero, IntPtr.Zero); return; }
        if (args.Contains("--prepare-only") || Headless)
        {
            try
            {
                Layout.PrepareAsync(new Progress<string>(), CancellationToken.None).GetAwaiter().GetResult();
                if (Headless) RunCliAsync("start").GetAwaiter().GetResult();
            }
            catch (Exception error) { Log(error); Environment.ExitCode = 1; }
            return;
        }
        using var window = new MainForm(background);
        using var context = new ApplicationContext();
        window.FormClosed += (_, _) => context.ExitThread();
        Application.ThreadException += (_, e) => { Log(e.Exception); window.ShowIssue("Не удалось обновить окно. Попробуйте открыть панель заново."); };
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Log(e.ExceptionObject as Exception);
        window.BeginStartup();
        if (!background) window.Show();
        Application.Run(context);
    }

    internal static bool IsUiDocument(string value) => Uri.TryCreate(value, UriKind.Absolute, out var uri) &&
        uri.Scheme == UiUri.Scheme && uri.Authority == UiUri.Authority && uri.UserInfo.Length == 0 &&
        uri.AbsolutePath is "/" or "/index.html";

    private static Icon LoadIcon()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("PcMcp.app.ico")
            ?? throw new InvalidOperationException("Application icon is missing.");
        using var icon = new Icon(stream, 256, 256);
        return (Icon)icon.Clone();
    }

    internal static void Log(Exception? error)
    {
        try { Directory.CreateDirectory(DataDir); File.AppendAllText(Path.Combine(DataDir, "ui-error.log"), $"{DateTime.UtcNow:O} {error}\n"); }
        catch (IOException) { Debug.WriteLine(error); }
        catch (UnauthorizedAccessException) { Debug.WriteLine(error); }
    }

    internal static async Task RunCliAsync(string command, CancellationToken cancellation = default)
    {
        await ServiceActions.WaitAsync(cancellation);
        try { await RunCliCoreAsync(command, cancellation); }
        finally { ServiceActions.Release(); }
    }

    private static async Task RunCliCoreAsync(string command, CancellationToken cancellation)
    {
        var bundledNode = Path.Combine(ProjectDir, "runtime", "node.exe");
        if (Layout.Bundled && !File.Exists(bundledNode)) throw new IOException("The bundled Node runtime is missing.");
        var info = new ProcessStartInfo(File.Exists(bundledNode) ? bundledNode : "node")
        { WorkingDirectory = ProjectDir, UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true, RedirectStandardOutput = true };
        info.ArgumentList.Add(Path.Combine(ProjectDir, "dist", "src", "cli.js"));
        info.ArgumentList.Add(command);
        if (command == "start") info.ArgumentList.Add("--no-wait");
        info.Environment["MCP_ENV_FILE"] = Layout.EnvFile;
        info.Environment["MCP_DATA_DIR"] = DataDir;
        info.Environment["MCP_LOCAL_ONLY"] = LocalOnly ? "true" : "false";
        if (Layout.Bundled)
        {
            info.Environment["MCP_DESKTOP_EXE"] = Environment.ProcessPath!;
            info.Environment["MCP_DESKTOP_MODE"] = Headless ? "cli" : "gui";
            info.Environment["CLOUDFLARED_BIN"] = Path.Combine(ProjectDir, "bin", "cloudflared.exe");
        }
        using var process = Process.Start(info) ?? throw new InvalidOperationException("Cannot start TMCP CLI.");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        deadline.CancelAfter(TimeSpan.FromSeconds(22));
        var stderr = process.StandardError.ReadToEndAsync(deadline.Token);
        var stdout = process.StandardOutput.ReadToEndAsync(deadline.Token);
        try
        {
            await process.WaitForExitAsync(deadline.Token);
            deadline.CancelAfter(TimeSpan.FromMilliseconds(500));
            try { await Task.WhenAll(stdout, stderr); }
            catch (OperationCanceledException) when (process.HasExited && !cancellation.IsCancellationRequested) { }
            if (process.ExitCode != 0)
                throw new InvalidOperationException(stderr.IsCompletedSuccessfully ? stderr.Result.Trim() : $"TMCP {command} failed (exit {process.ExitCode}).");
        }
        catch (OperationCanceledException) when (!cancellation.IsCancellationRequested)
        { if (!process.HasExited) process.Kill(); throw new TimeoutException($"TMCP {command} did not finish within 22 seconds."); }
        finally { deadline.Cancel(); }
    }
}

internal static class Native
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern uint RegisterWindowMessage(string name);
    [DllImport("user32.dll")] internal static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] internal static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("dwmapi.dll")] internal static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);
}
