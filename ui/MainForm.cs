using System.Diagnostics;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace PcMcp;

internal sealed class MainForm : Form
{
    private WebView2? _web;
    private ControlBridge? _bridge;
    private readonly Panel _waiting;
    private readonly Label _message, _heading;
    private readonly Button _retry;
    private readonly DesktopTray _tray;
    private readonly HttpClient _http = ControlPipe.CreateClient();
    private readonly CancellationTokenSource _closing = new();
    private readonly bool _background;
    private bool _disposed, _quitting, _stopping, _pageLoaded, _navigating, _buildingWebView, _online, _prepared, _monitorStarted, _tipShown;
    private string? _pendingPage;
    private DateTime _lastStart = DateTime.MinValue;
    private Task? _startup;
    private WindowsUpdates? _updates;

    public MainForm(bool background)
    {
        _background = background;
        Text = "PC MCP"; Icon = Program.AppIcon; Size = new Size(1260, 880); MinimumSize = new Size(900, 620);
        StartPosition = FormStartPosition.CenterScreen; BackColor = Color.FromArgb(16, 20, 25); Font = new Font("Segoe UI", 10);
        _waiting = new Panel { Dock = DockStyle.Fill, BackColor = BackColor };
        var stack = new TableLayoutPanel { AutoSize = true, ColumnCount = 1, RowCount = 5, Anchor = AnchorStyles.None, Width = 520, BackColor = BackColor };
        var image = new PictureBox { Image = Program.AppIcon.ToBitmap(), SizeMode = PictureBoxSizeMode.Zoom, Size = new Size(66, 66), Anchor = AnchorStyles.None, Margin = new Padding(0, 0, 0, 24) };
        _heading = new Label { Text = "Подключаем ваш компьютер", AutoSize = true, ForeColor = Color.FromArgb(237, 242, 247), Font = new Font("Segoe UI", 21), Anchor = AnchorStyles.None, Margin = new Padding(0, 0, 0, 14) };
        _message = new Label { Text = "Готовим компоненты и панель управления…", ForeColor = Color.FromArgb(168, 180, 195), AutoSize = true, MaximumSize = new Size(500, 120), Anchor = AnchorStyles.None, TextAlign = ContentAlignment.MiddleCenter, Margin = new Padding(0, 0, 0, 22) };
        _retry = new Button { Text = "Повторить подключение", AutoSize = true, Padding = new Padding(15, 8, 15, 8), BackColor = Color.FromArgb(242, 177, 75), ForeColor = Color.FromArgb(36, 21, 3), FlatStyle = FlatStyle.Flat, Anchor = AnchorStyles.None };
        _retry.FlatAppearance.BorderSize = 0;
        _retry.Click += async (_, _) => { if (_startup?.IsCompleted != false) { _startup = StartAsync(); await _startup; } };
        var progress = new ProgressBar { Style = ProgressBarStyle.Marquee, MarqueeAnimationSpeed = 24, Size = new Size(240, 4), Anchor = AnchorStyles.None, Margin = new Padding(0, 0, 0, 20) };
        stack.Controls.Add(image); stack.Controls.Add(_heading); stack.Controls.Add(_message); stack.Controls.Add(progress); stack.Controls.Add(_retry);
        _waiting.Controls.Add(stack);
        _waiting.Resize += (_, _) => { stack.Left = (_waiting.Width - stack.Width) / 2; stack.Top = (_waiting.Height - stack.Height) / 2; };
        Controls.Add(_waiting);
        _tray = new DesktopTray(Navigate, () => _tray!.CopyLink(), RestartAsync, ToggleStartupAsync, ToggleMinimizedAsync,
            ConfirmQuitAsync, () => OpenLocal(Program.Layout.Home), () => OpenLocal(Path.Combine(Program.DataDir, "server.log")), RefreshStartupAsync, !Program.Preview);
    }

    internal void BeginStartup()
    {
        _ = Handle;
        SetTheme(true);
        BeginInvoke(new Action(() => _startup = StartAsync()));
    }

    private async Task StartAsync()
    {
        _retry.Enabled = false;
        _tray.SetBusy(true, "подготовка компонентов…");
        try
        {
            var progress = new Progress<string>(text => { if (!_quitting && !IsDisposed) _message.Text = text; });
            await Program.Layout.PrepareAsync(progress, _closing.Token);
            _updates ??= new WindowsUpdates(Program.Layout.Home, Program.Layout.Version,
                Program.Layout.Bundled && !Program.Preview && Environment.GetEnvironmentVariable("TMCP_DISABLE_UPDATES") != "true",
                PublishUpdateStatus, ApplyUpdateAsync);
            _prepared = true;
            if (!Program.Preview) { await Program.RunCliAsync("start", _closing.Token); _lastStart = DateTime.UtcNow; }
            _tray.SetBusy(false);
            await ConnectAsync();
            if (!_monitorStarted) { _monitorStarted = true; _ = MonitorAsync(); }
            if (_background) _tray.Notify("TMCP работает в трее", "Нажмите значок, чтобы открыть окно. Правой кнопкой — управление и полный выход.");
        }
        catch (OperationCanceledException) when (_closing.IsCancellationRequested) { }
        catch (Exception error) { Program.Log(error); ShowIssue("Не удалось подготовить приложение. Повторите запуск или проверьте журнал ui-error.log."); _tray.Notify("TMCP: нужна проверка", error.Message, true); }
        finally { _tray.SetBusy(false); if (!IsDisposed) _retry.Enabled = true; }
    }

    public void ShowIssue(string message)
    {
        if (IsDisposed || _quitting) return;
        _message.Text = message; _waiting.Visible = true; _waiting.BringToFront(); _pageLoaded = false;
    }

    private async Task MonitorAsync()
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(3));
        try { while (await timer.WaitForNextTickAsync(_closing.Token)) await ConnectAsync(); }
        catch (OperationCanceledException) { }
        catch (Exception error) { Program.Log(error); ShowIssue("Не удалось обновить состояние. Повторите подключение."); }
    }

    private async Task<JsonElement> ApiAsync(string path, object? body = null, string method = "GET")
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(_closing.Token);
        deadline.CancelAfter(TimeSpan.FromSeconds(path == "/autostart" ? 60 : 15));
        using var request = new HttpRequestMessage(new HttpMethod(method), "/_control/api" + path);
        if (body != null) request.Content = JsonContent.Create(body);
        using var response = await _http.SendAsync(request, deadline.Token);
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(deadline.Token));
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException(document.RootElement.TryGetProperty("message", out var message) ? message.GetString() : "Не удалось выполнить действие.");
        return document.RootElement.Clone();
    }

    private async Task ConnectAsync()
    {
        if (_quitting || _stopping || _buildingWebView) return;
        JsonElement? state = null;
        try { state = await ApiAsync("/state"); }
        catch (HttpRequestException) { }
        catch (TaskCanceledException) { }
        catch (Exception error) when (error is JsonException or InvalidOperationException) { Program.Log(error); }
        if (_closing.IsCancellationRequested || _stopping || _quitting) return;
        var connected = state.HasValue && state.Value.TryGetProperty("connection", out _);
        _tray.State(connected, connected ? state : null);
        if (!connected)
        {
            _online = false;
            if (!_pageLoaded) _message.Text = "Сервер ещё не ответил. Подключение повторяется автоматически.";
            if (!Program.Preview && !File.Exists(Path.Combine(Program.DataDir, "stop.request")) && DateTime.UtcNow - _lastStart > TimeSpan.FromSeconds(10))
            {
                _lastStart = DateTime.UtcNow;
                try { await Program.RunCliAsync("start", _closing.Token); }
                catch (Exception error) { Program.Log(error); ShowIssue("Не удалось запустить сервер. Нажмите «Повторить подключение»."); }
            }
            return;
        }
        if (_web?.CoreWebView2 == null) await BuildWebViewAsync();
        if (_web?.CoreWebView2 == null) return;
        if (!_pageLoaded && !_navigating) { _navigating = true; _web.Source = Program.UiUri; }
        else if (!_online) _web.CoreWebView2.PostWebMessageAsJson("{\"type\":\"server-ready\"}");
        _online = true;
        if (_updates != null && _pageLoaded && state is { } current)
        {
            PublishUpdateStatus(_updates.State);
            await _updates.TickAsync(current.GetProperty("settings").GetProperty("updates").GetProperty("enabled").GetBoolean());
        }
    }

    private async Task BuildWebViewAsync()
    {
        _buildingWebView = true;
        try
        {
            _bridge?.Dispose(); _web?.Dispose();
            _web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = BackColor };
            Controls.Add(_web); _waiting.BringToFront();
            var browserData = Program.Layout.Payload is { } payload
                ? Path.Combine(Program.DataDir, "browser", payload.Webview) : Path.Combine(Program.DataDir, "browser");
            var environment = await CoreWebView2Environment.CreateAsync(Program.Layout.Browser, browserData);
            await _web.EnsureCoreWebView2Async(environment);
            var core = _web.CoreWebView2;
            core.SetVirtualHostNameToFolderMapping(Program.UiUri.Host, Path.Combine(Program.ProjectDir, "ui", "public"), CoreWebView2HostResourceAccessKind.DenyCors);
            _bridge = new ControlBridge(core, _http);
            var settings = core.Settings;
            settings.IsStatusBarEnabled = false; settings.AreDefaultContextMenusEnabled = false;
            settings.AreDefaultScriptDialogsEnabled = false; settings.AreDevToolsEnabled = Program.Preview;
            settings.AreBrowserAcceleratorKeysEnabled = false; settings.AreHostObjectsAllowed = false;
            settings.IsBuiltInErrorPageEnabled = false; settings.IsZoomControlEnabled = false;
            core.NavigationStarting += (_, e) => { if (!Program.IsUiDocument(e.Uri)) e.Cancel = true; else _bridge.CancelAll(); };
            core.NewWindowRequested += (_, e) => e.Handled = true;
            core.WebMessageReceived += HandleWebMessageAsync;
            core.ProcessFailed += (_, _) => { _pageLoaded = false; _navigating = false; ShowIssue("Панель восстанавливается. Сервер продолжает работу."); BeginInvoke(new Action(async () => { await BuildWebViewAsync(); await ConnectAsync(); })); };
            _web.NavigationCompleted += (_, e) =>
            {
                _navigating = false; _pageLoaded = e.IsSuccess;
                if (_pageLoaded) { _waiting.Visible = false; _web.BringToFront(); if (_pendingPage != null) SendPage(_pendingPage); if (_updates != null) PublishUpdateStatus(_updates.State); }
                else ShowIssue("Панель пока недоступна. Повторяем подключение…");
            };
        }
        catch (Exception error) { Program.Log(error); ShowIssue("Не удалось открыть панель WebView2. Повторите подготовку приложения."); }
        finally { _buildingWebView = false; }
    }

    private async void HandleWebMessageAsync(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            if (!Program.IsUiDocument(e.Source)) return;
            using var message = JsonDocument.Parse(e.WebMessageAsJson);
            if (!message.RootElement.TryGetProperty("type", out var type)) return;
            if (type.GetString() == "theme" && message.RootElement.TryGetProperty("theme", out var theme)) SetTheme(theme.GetString() != "light");
            else if (type.GetString() == "ui-ready" && Program.MarkUpdateReady()) _tray.Notify("TMCP обновлён", $"Версия {Program.Layout.Version} установлена автоматически.");
            else if (type.GetString() == "quit") await QuitAsync();
            else if (type.GetString() == "tray-menu") _tray.ShowMenu(PointToScreen(new Point(Width - 360, Height - 100)));
            else if (type.GetString() == "check-updates" && _updates != null) await _updates.CheckAsync(true);
            else if (type.GetString() == "update-status" && _updates != null) PublishUpdateStatus(_updates.State);
            else if (_bridge != null) await _bridge.HandleAsync(message.RootElement);
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException or KeyNotFoundException) { Program.Log(error); }
    }

    private void SetTheme(bool dark)
    {
        var value = dark ? 1 : 0; Native.DwmSetWindowAttribute(Handle, 20, ref value, sizeof(int));
        BackColor = dark ? Color.FromArgb(16, 20, 25) : Color.FromArgb(243, 245, 247);
        _tray.SetTheme(dark);
    }

    private void PublishUpdateStatus(UpdateStatus status)
    {
        if (_quitting || IsDisposed) return;
        _web?.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(new { type = "update-status", update = status },
            new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase }));
    }

    private async Task<bool> UpdateIdleAsync()
    {
        if (_web?.CoreWebView2 == null || !_pageLoaded || OwnedForms.Any(form => form.Visible)) return false;
        var state = await ApiAsync("/state");
        if (state.GetProperty("jobs").EnumerateArray().Any(job => job.GetProperty("status").GetString() == "running") ||
            state.GetProperty("approvals").GetArrayLength() != 0 ||
            state.GetProperty("traffic").GetProperty("stats").GetProperty("active").GetInt32() != 0 ||
            state.GetProperty("gateway").GetProperty("activeCalls").GetInt32() != 0) return false;
        return await _web.ExecuteScriptAsync("typeof window.tmcpCanUpdate === 'function' && window.tmcpCanUpdate()") == "true";
    }

    private async Task<bool> ApplyUpdateAsync(UpdatePlan plan)
    {
        if (_quitting || _stopping || !await UpdateIdleAsync()) return false;
        _stopping = true;
        string? abort = null;
        Process? installer = null;
        try
        {
            await ApiAsync("/maintenance", new { enabled = true }, "PATCH");
            if (!await UpdateIdleAsync()) { await ApiAsync("/maintenance", new { enabled = false }, "PATCH"); return false; }
            _heading.Text = "Обновляем TMCP";
            _message.Text = "Проверенный EXE будет установлен автоматически. Настройки и ключи сохранятся.";
            _waiting.Visible = true; _waiting.BringToFront();
            _tray.SetBusy(true, "устанавливаем обновление…");
            (installer, abort) = await WindowsUpdates.StartInstallerAsync(plan, Visible, _closing.Token);
            await ApiAsync("/maintenance", new { enabled = true }, "PATCH");
            if (!await UpdateIdleAsync()) throw new IOException("Во время подготовки появились активные операции. Обновление отложено; команды продолжают работать.");
            await Program.RunCliAsync("stop");
            _quitting = true; Close();
            return true;
        }
        catch
        {
            if (abort != null) await File.WriteAllTextAsync(abort, "abort");
            if (installer != null && !installer.HasExited)
            {
                using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                try { await installer.WaitForExitAsync(deadline.Token); }
                catch (OperationCanceledException) { if (!installer.HasExited) installer.Kill(); }
            }
            try { await ApiAsync("/maintenance", new { enabled = false }, "PATCH"); }
            catch (Exception error) { Program.Log(error); }
            await Program.RunCliAsync("start");
            _waiting.Visible = false;
            throw;
        }
        finally { installer?.Dispose(); if (!_quitting) { _stopping = false; _tray.SetBusy(false); } }
    }
    private void ShowWindow() { Show(); ShowInTaskbar = true; WindowState = FormWindowState.Normal; Activate(); Native.SetForegroundWindow(Handle); }
    private void Navigate(string page) { ShowWindow(); if (page.Length != 0) { _pendingPage = page; if (_pageLoaded) SendPage(page); } }
    private void SendPage(string page) { _web?.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(new { type = "navigate", page })); _pendingPage = null; }

    private async Task RefreshStartupAsync()
    {
        if (!_online || _stopping) return;
        try { _tray.SetStartup((await ApiAsync("/autostart")).GetProperty("enabled").GetBoolean()); }
        catch (Exception error) when (error is HttpRequestException or OperationCanceledException or InvalidOperationException) { Program.Log(error); }
    }

    private async Task ToggleStartupAsync() => await TrayActionAsync(async () =>
    {
        var current = await ApiAsync("/autostart");
        var enabled = !current.GetProperty("enabled").GetBoolean();
        var result = await ApiAsync("/autostart", new { enabled }, "PATCH");
        _tray.SetStartup(result.GetProperty("enabled").GetBoolean());
        _tray.Notify("Автозагрузка TMCP", enabled ? "Приложение установлено и будет запускаться при входе в Windows." : "Автозагрузка отключена.");
    }, "настройка автозагрузки…");

    private async Task ToggleMinimizedAsync() => await TrayActionAsync(async () =>
    {
        await ApiAsync("/settings", new { ui = new { startMinimized = !_tray.Minimized } }, "PATCH");
        await ConnectAsync();
    }, "сохраняем режим запуска…");

    private async Task TrayActionAsync(Func<Task> action, string message)
    {
        _tray.SetBusy(true, message);
        try { await action(); }
        catch (Exception error) { Program.Log(error); _tray.Notify("Не удалось выполнить действие", error.Message, true); }
        finally { _tray.SetBusy(false); await ConnectAsync(); }
    }

    private async Task RestartAsync()
    {
        if (_online)
        {
            ShowWindow();
            if (!ConfirmDialog.Show(this, "Перезапустить сервер?", $"Активных команд: {_tray.Jobs}. Они будут остановлены. Адрес быстрого туннеля может измениться.", "Перезапустить")) return;
        }
        await TrayActionAsync(async () => { if (!Program.Preview) await Program.RunCliAsync(_online ? "restart" : "start", _closing.Token); }, "перезапускаем сервер…");
    }

    private void OpenLocal(string target)
    {
        try
        {
            if (Directory.Exists(target)) Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
            else if (File.Exists(target)) { var start = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "notepad.exe")) { UseShellExecute = false }; start.ArgumentList.Add(target); Process.Start(start); }
            else _tray.Notify("TMCP", "Журнал появится после запуска сервера.");
        }
        catch (Exception error) { Program.Log(error); _tray.Notify("TMCP", "Не удалось открыть файл или папку.", true); }
    }

    private async Task ConfirmQuitAsync()
    {
        ShowWindow();
        if (ConfirmDialog.Show(this, "Полностью завершить работу TMCP?", $"Сервер, туннель и активные команды ({_tray.Jobs}) будут остановлены. Значок исчезнет из трея.", "Остановить и выйти", true)) await QuitAsync();
    }

    private async Task QuitAsync()
    {
        if (_quitting || _stopping) return;
        _stopping = true; _retry.Enabled = false; _tray.SetBusy(true, "завершаем работу…");
        _heading.Text = "Завершаем работу"; _message.Text = "Останавливаем команды и туннель. Окно закроется автоматически.";
        _waiting.Visible = true; _waiting.BringToFront(); ShowWindow();
        try
        {
            if (!_prepared) { _closing.Cancel(); if (_startup != null) await _startup; }
            else if (!Program.Preview) await Program.RunCliAsync("stop");
        }
        catch (Exception error) { Program.Log(error); _stopping = false; _heading.Text = "Не удалось завершить работу"; ShowIssue("Повторите выход или проверьте журнал. Команда остановки уже отправлена."); _tray.SetBusy(false); _retry.Enabled = true; return; }
        _quitting = true; Close();
    }

    protected override void WndProc(ref Message message)
    { if (message.Msg == Program.ShowMessage) { ShowWindow(); return; } base.WndProc(ref message); }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (!_quitting && !Program.Preview && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true; Hide();
            if (!_tipShown) { _tipShown = true; _tray.Notify("TMCP продолжает работать", "Полный выход: правая кнопка на значке → «Остановить сервер и выйти из TMCP». Нажмите значок, чтобы вернуть окно."); }
            return;
        }
        _quitting = true; _closing.Cancel(); base.OnFormClosing(e);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing && !_disposed)
        { _disposed = true; _closing.Cancel(); _updates?.Dispose(); _bridge?.Dispose(); _web?.Dispose(); _tray.Dispose(); _http.Dispose(); _closing.Dispose(); }
        base.Dispose(disposing);
    }
}
