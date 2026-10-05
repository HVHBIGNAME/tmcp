using System.Diagnostics;
using System.Globalization;
using System.Net.Http;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace PcMcp;

internal static class Program
{
    internal static readonly string ProjectDir = FindProject();
    internal static readonly string DataDir = Path.Combine(ProjectDir, ".mcp-tunnel");
    internal static readonly Uri ControlUri = GetControlUri();
    internal static readonly bool Preview = !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("PC_MCP_UI_CONTROL_URL"));
    internal static readonly Icon AppIcon = LoadIcon();

    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        // WinForms needs real cultures when WebView2 reports keyboard layout changes.
        _ = CultureInfo.GetCultureInfo(1049);
        using var single = new Mutex(true, @"Local\TmcpDesktop-" + ControlUri.Port, out var first);
        if (!first)
        {
            var existing = Native.FindWindow(null, "PC MCP");
            if (existing != IntPtr.Zero) { Native.ShowWindow(existing, 9); Native.SetForegroundWindow(existing); }
            return;
        }
        using var window = new MainForm(args.Contains("--background"));
        Application.ThreadException += (_, e) => { Log(e.Exception); window.ShowIssue("Не удалось обновить окно. Попробуйте открыть панель заново."); };
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Log(e.ExceptionObject as Exception);
        Application.Run(window);
    }

    private static string FindProject()
    {
        var current = new DirectoryInfo(AppContext.BaseDirectory);
        for (var i = 0; current != null && i < 7; i++, current = current.Parent)
            if (File.Exists(Path.Combine(current.FullName, "package.json"))) return current.FullName;
        return AppContext.BaseDirectory;
    }

    private static Uri GetControlUri()
    {
        var value = Environment.GetEnvironmentVariable("PC_MCP_UI_CONTROL_URL");
        if (!string.IsNullOrEmpty(value))
        {
            var uri = new Uri(value);
            if (!uri.IsLoopback || uri.Scheme != "http") throw new InvalidOperationException("Control URL must be loopback HTTP.");
            return uri;
        }
        var port = 18790;
        var env = Path.Combine(ProjectDir, ".env");
        if (File.Exists(env))
            foreach (var line in File.ReadLines(env))
                if (line.StartsWith("MCP_CONTROL_PORT=") && int.TryParse(line.Split('=', 2)[1].Trim(), out var configured) && configured is >= 1024 and <= 65535) port = configured;
        return new Uri($"http://127.0.0.1:{port}");
    }

    private static Icon LoadIcon()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("PcMcp.app.ico")
            ?? throw new InvalidOperationException("Application icon is missing.");
        using var icon = new Icon(stream, 256, 256);
        return (Icon)icon.Clone();
    }

    internal static void Log(Exception? error)
    {
        try
        {
            Directory.CreateDirectory(DataDir);
            File.AppendAllText(Path.Combine(DataDir, "ui-error.log"), $"{DateTime.UtcNow:O} {error}\n");
        }
        catch (IOException) { Debug.WriteLine(error); }
        catch (UnauthorizedAccessException) { Debug.WriteLine(error); }
    }

    internal static async Task RunCliAsync(string command, CancellationToken cancellation = default)
    {
        var bundledNode = Path.Combine(ProjectDir, "runtime", "node.exe");
        var info = new ProcessStartInfo(File.Exists(bundledNode) ? bundledNode : "node")
        {
            WorkingDirectory = ProjectDir, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardError = true, RedirectStandardOutput = true,
        };
        info.ArgumentList.Add(Path.Combine(ProjectDir, "dist", "src", "cli.js"));
        info.ArgumentList.Add(command);
        if (command == "start") info.ArgumentList.Add("--no-wait");
        using var process = Process.Start(info) ?? throw new InvalidOperationException("Cannot start TMCP CLI.");
        var stderr = process.StandardError.ReadToEndAsync(cancellation);
        var stdout = process.StandardOutput.ReadToEndAsync(cancellation);
        await process.WaitForExitAsync(cancellation);
        await stdout;
        if (process.ExitCode != 0) throw new InvalidOperationException((await stderr).Trim());
    }
}

internal sealed class MainForm : Form
{
    private WebView2? _web;
    private readonly Panel _waiting;
    private readonly Label _message;
    private readonly NotifyIcon _tray;
    private readonly ContextMenuStrip _menu;
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(3) };
    private readonly CancellationTokenSource _closing = new();
    private readonly bool _background;
    private bool _quitting;
    private bool _pageLoaded;
    private bool _navigating;
    private bool _buildingWebView;
    private bool _online;
    private DateTime _lastStart = DateTime.MinValue;

    public MainForm(bool background)
    {
        _background = background;
        Text = "PC MCP";
        Icon = Program.AppIcon;
        Size = new Size(1260, 880);
        MinimumSize = new Size(900, 620);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(17, 21, 25);
        Font = new Font("Segoe UI", 10);

        _waiting = new Panel { Dock = DockStyle.Fill, BackColor = BackColor };
        var stack = new TableLayoutPanel { AutoSize = true, ColumnCount = 1, RowCount = 4, Anchor = AnchorStyles.None, Width = 520, BackColor = BackColor };
        var image = new PictureBox { Image = Program.AppIcon.ToBitmap(), SizeMode = PictureBoxSizeMode.Zoom, Size = new Size(66, 66), Anchor = AnchorStyles.None, Margin = new Padding(0, 0, 0, 24) };
        var title = new Label { Text = "Подключаем ваш компьютер", AutoSize = true, ForeColor = Color.FromArgb(235, 241, 240), Font = new Font("Segoe UI", 21, FontStyle.Regular), Anchor = AnchorStyles.None, Margin = new Padding(0, 0, 0, 14) };
        _message = new Label { Text = "Запускаем сервер и готовим панель управления…", ForeColor = Color.FromArgb(146, 163, 166), AutoSize = true, MaximumSize = new Size(500, 120), Anchor = AnchorStyles.None, TextAlign = ContentAlignment.MiddleCenter, Margin = new Padding(0, 0, 0, 22) };
        var retry = new Button { Text = "Повторить подключение", AutoSize = true, Padding = new Padding(15, 8, 15, 8), BackColor = Color.FromArgb(142, 228, 189), ForeColor = Color.FromArgb(17, 41, 31), FlatStyle = FlatStyle.Flat, Anchor = AnchorStyles.None };
        retry.FlatAppearance.BorderSize = 0;
        retry.Click += async (_, _) =>
        {
            retry.Enabled = false;
            try { if (!Program.Preview) await Program.RunCliAsync("start", _closing.Token); _lastStart = DateTime.UtcNow; await ConnectAsync(); }
            catch (Exception error) { Program.Log(error); _message.Text = "Не удалось запустить сервер. Проверьте Node.js и журнал .mcp-tunnel/ui-error.log."; }
            finally { retry.Enabled = true; }
        };
        stack.Controls.Add(image); stack.Controls.Add(title); stack.Controls.Add(_message); stack.Controls.Add(retry);
        _waiting.Controls.Add(stack);
        _waiting.Resize += (_, _) => { stack.Left = (_waiting.Width - stack.Width) / 2; stack.Top = (_waiting.Height - stack.Height) / 2; };
        Controls.Add(_waiting);

        _tray = new NotifyIcon { Icon = Program.AppIcon, Text = "PC MCP · сервер работает в фоне", Visible = !Program.Preview };
        _tray.DoubleClick += (_, _) => ShowWindow();
        _menu = new ContextMenuStrip();
        _menu.Items.Add("Открыть панель", null, (_, _) => ShowWindow());
        _menu.Items.Add(new ToolStripSeparator());
        _menu.Items.Add("Остановить сервер и выйти", null, async (_, _) => await QuitAsync());
        _tray.ContextMenuStrip = _menu;
        Shown += async (_, _) =>
        {
            SetTheme(true);
            if (_background) Hide();
            if (!Program.Preview)
            {
                try { await Program.RunCliAsync("start", _closing.Token); _lastStart = DateTime.UtcNow; }
                catch (Exception error) { Program.Log(error); ShowIssue("Не удалось запустить сервер. Нажмите «Повторить подключение»."); }
            }
            await ConnectAsync();
            await MonitorAsync();
        };
    }

    public void ShowIssue(string message)
    {
        if (IsDisposed || _quitting) return;
        _message.Text = message;
        _waiting.Visible = true;
        _waiting.BringToFront();
        _pageLoaded = false;
    }

    private async Task MonitorAsync()
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(3));
        try { while (await timer.WaitForNextTickAsync(_closing.Token)) await ConnectAsync(); }
        catch (OperationCanceledException) { }
    }

    private async Task ConnectAsync()
    {
        if (_quitting || _buildingWebView) return;
        var connected = false;
        try
        {
            using var response = await _http.GetAsync(new Uri(Program.ControlUri, "/_control/bootstrap"), _closing.Token);
            if (response.IsSuccessStatusCode)
            {
                using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(_closing.Token));
                connected = body.RootElement.TryGetProperty("adminToken", out var admin) && !string.IsNullOrWhiteSpace(admin.GetString());
            }
        }
        catch (HttpRequestException) { }
        catch (TaskCanceledException) { }
        catch (JsonException error) { Program.Log(error); }
        if (_closing.IsCancellationRequested) return;

        if (!connected)
        {
            _online = false;
            if (!_pageLoaded) _message.Text = "Сервер ещё не ответил. Подключение повторяется автоматически.";
            if (!Program.Preview && !File.Exists(Path.Combine(Program.DataDir, "stop.request")) && DateTime.UtcNow - _lastStart > TimeSpan.FromSeconds(10))
            {
                _lastStart = DateTime.UtcNow;
                try { await Program.RunCliAsync("start", _closing.Token); }
                catch (Exception error) { Program.Log(error); ShowIssue("Не удалось запустить сервер. Нажмите «Повторить подключение» или выполните tmcp logs."); }
            }
            return;
        }
        if (_web?.CoreWebView2 == null) await BuildWebViewAsync();
        if (_web?.CoreWebView2 == null) return;
        if (!_pageLoaded && !_navigating)
        {
            _navigating = true;
            _web.Source = new Uri(Program.ControlUri, "/ui/");
        }
        else if (!_online) _web.CoreWebView2.PostWebMessageAsJson("{\"type\":\"server-ready\"}");
        _online = true;
    }

    private async Task BuildWebViewAsync()
    {
        _buildingWebView = true;
        try
        {
            _web?.Dispose();
            _web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = BackColor };
            Controls.Add(_web);
            _waiting.BringToFront();
            var browserData = Program.Preview ? Path.Combine(Path.GetTempPath(), "tmcp-preview-" + Program.ControlUri.Port) : Path.Combine(Program.DataDir, "browser");
            var environment = await CoreWebView2Environment.CreateAsync(null, browserData);
            await _web.EnsureCoreWebView2Async(environment);
            var settings = _web.CoreWebView2.Settings;
            settings.IsStatusBarEnabled = false;
            settings.AreDefaultContextMenusEnabled = false;
            settings.AreDefaultScriptDialogsEnabled = false;
            settings.AreDevToolsEnabled = Program.Preview;
            settings.AreBrowserAcceleratorKeysEnabled = false;
            settings.AreHostObjectsAllowed = false;
            settings.IsBuiltInErrorPageEnabled = false;
            settings.IsZoomControlEnabled = false;
            _web.CoreWebView2.NavigationStarting += (_, e) =>
            {
                if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out var target) || target.Authority != Program.ControlUri.Authority || target.Scheme != "http" || !target.AbsolutePath.StartsWith("/ui/")) e.Cancel = true;
            };
            _web.CoreWebView2.NewWindowRequested += (_, e) => e.Handled = true;
            _web.CoreWebView2.WebMessageReceived += (_, e) =>
            {
                try
                {
                    using var message = JsonDocument.Parse(e.WebMessageAsJson);
                    if (message.RootElement.TryGetProperty("type", out var type) && type.GetString() == "theme" && message.RootElement.TryGetProperty("theme", out var theme)) SetTheme(theme.GetString() != "light");
                }
                catch (JsonException error) { Program.Log(error); }
            };
            _web.CoreWebView2.ProcessFailed += (_, _) =>
            {
                _pageLoaded = false;
                _navigating = false;
                ShowIssue("Панель восстанавливается. Сервер и команды продолжают работать.");
                BeginInvoke(new Action(async () => { await BuildWebViewAsync(); await ConnectAsync(); }));
            };
            _web.NavigationCompleted += (_, e) =>
            {
                _navigating = false;
                _pageLoaded = e.IsSuccess;
                if (_pageLoaded) { _waiting.Visible = false; _web.BringToFront(); }
                else ShowIssue("Панель пока недоступна. Повторяем подключение…");
            };
        }
        catch (Exception error)
        {
            Program.Log(error);
            ShowIssue("Не удалось открыть панель. Установите Microsoft Edge WebView2 Runtime и повторите попытку.");
        }
        finally { _buildingWebView = false; }
    }

    private void SetTheme(bool dark)
    {
        var value = dark ? 1 : 0;
        Native.DwmSetWindowAttribute(Handle, 20, ref value, sizeof(int));
        BackColor = dark ? Color.FromArgb(17, 21, 25) : Color.FromArgb(243, 246, 245);
    }

    private void ShowWindow() { Show(); WindowState = FormWindowState.Normal; Activate(); }

    private async Task QuitAsync()
    {
        if (_quitting) return;
        _menu.Enabled = false;
        try { if (!Program.Preview) await Program.RunCliAsync("stop"); }
        catch (Exception error) { Program.Log(error); ShowIssue("Не удалось остановить сервер. Повторите выход или выполните tmcp stop."); ShowWindow(); _menu.Enabled = true; return; }
        _quitting = true;
        Close();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (!_quitting && !Program.Preview && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            Hide();
            return;
        }
        _quitting = true;
        _closing.Cancel();
        _tray.Visible = false;
        base.OnFormClosing(e);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) { _closing.Cancel(); _web?.Dispose(); _tray.Dispose(); _menu.Dispose(); _http.Dispose(); _closing.Dispose(); }
        base.Dispose(disposing);
    }
}

internal static class Native
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern IntPtr FindWindow(string? className, string title);
    [DllImport("user32.dll")] internal static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] internal static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("dwmapi.dll")] internal static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);
}
