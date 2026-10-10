using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace PcMcp;

internal sealed class DesktopTray : IDisposable
{
    private readonly NotifyIcon _icon;
    private readonly ContextMenuStrip _menu;
    private readonly ToolStripMenuItem _server, _tunnel, _summary, _copy, _restart, _startup, _minimized;
    private readonly List<Image> _images = new();
    private readonly Icon _onlineIcon = StatusIcon(Color.FromArgb(84, 191, 142));
    private readonly Icon _offlineIcon = StatusIcon(Color.FromArgb(242, 177, 75));
    private bool _busy;
    private string? _url;
    internal int Jobs { get; private set; }
    internal bool Minimized => _minimized.Checked;
    internal bool Startup => _startup.Checked;

    internal DesktopTray(Action<string> navigate, Action copy, Func<Task> restart,
        Func<Task> startup, Func<Task> minimized, Func<Task> quit, Action folder, Action logs,
        Func<Task> refresh, bool visible)
    {
        _menu = new ContextMenuStrip { ShowImageMargin = true, ShowCheckMargin = false, ImageScalingSize = new Size(18, 18), Font = new Font("Segoe UI", 10) };
        var title = Add("TMCP  ·  " + Program.Layout.Version, "title", null);
        title.Font = new Font("Segoe UI", 11, FontStyle.Bold); title.Enabled = false;
        _server = Add("Подготавливаем сервер…", "server", null); _server.Enabled = false;
        _tunnel = Add("Туннель: ожидаем подключение", "tunnel", null); _tunnel.Enabled = false;
        _summary = Add("Ключи · запросы · команды", "summary", null); _summary.Enabled = false;
        _menu.Items.Add(new ToolStripSeparator());
        var open = Add("Открыть TMCP", "open", () => navigate(""));
        open.Font = new Font(_menu.Font, FontStyle.Bold);
        Add("Доступ и ключи", "keys", () => navigate("tokens"));
        Add("Запросы на подтверждение", "requests", () => navigate("approvals"));
        _copy = Add("Копировать MCP-ссылку", "copy", copy); _copy.Enabled = false;
        _menu.Items.Add(new ToolStripSeparator());
        _restart = Add("Перезапустить сервер…", "restart", async () => await restart());
        var automatic = Add("Автозагрузка", "settings", null);
        _startup = new ToolStripMenuItem("Запускать при входе в систему", null, async (_, _) => await startup()) { Name = "startup", CheckOnClick = false };
        _minimized = new ToolStripMenuItem("Запускать свёрнутым в трей", null, async (_, _) => await minimized()) { Name = "minimized", CheckOnClick = false };
        automatic.DropDownItems.AddRange(new ToolStripItem[] { _startup, _minimized });
        Add("Открыть папку приложения", "folder", folder);
        Add("Открыть журнал сервера", "logs", logs);
        _menu.Items.Add(new ToolStripSeparator());
        var exit = Add("Остановить сервер и выйти из TMCP…", "exit", async () => await quit());
        exit.Font = new Font(_menu.Font, FontStyle.Bold); exit.ForeColor = Color.FromArgb(231, 112, 104);
        _menu.Opening += async (_, _) => await refresh();
        _icon = new NotifyIcon { Icon = _offlineIcon, Text = "TMCP · подготовка сервера", ContextMenuStrip = _menu, Visible = visible };
        _icon.MouseClick += (_, e) => { if (e.Button == MouseButtons.Left) navigate(""); };
        SetTheme(true);
    }

    private ToolStripMenuItem Add(string text, string name, Action? action)
    {
        var item = new ToolStripMenuItem(text) { Name = name, Padding = new Padding(5, 5, 12, 5) };
        if (action != null) item.Click += (_, _) => action();
        if (name is not ("title" or "server" or "tunnel" or "summary"))
        { var image = Glyph(name); _images.Add(image); item.Image = image; }
        _menu.Items.Add(item);
        return item;
    }

    internal void State(bool online, JsonElement? state = null)
    {
        if (_busy) return;
        _server.Text = online ? "Сервер работает" : "Сервер не подключён";
        _icon.Icon = online ? _onlineIcon : _offlineIcon;
        _restart.Text = online ? "Перезапустить сервер…" : "Запустить сервер";
        _url = null;
        if (state is { } value)
        {
            var connection = value.GetProperty("connection");
            var status = connection.GetProperty("status").GetString();
            _tunnel.Text = status switch
            {
                "connected" => "Туннель: зарегистрирован", "local" => "Режим: локальный доступ",
                "reconnecting" => "Туннель: переподключение", "error" => "Туннель: нужна проверка",
                _ => "Туннель: подключение…",
            };
            if (connection.TryGetProperty("mcpUrl", out var url) && url.ValueKind == JsonValueKind.String) _url = url.GetString();
            Jobs = value.GetProperty("jobs").EnumerateArray().Count(job => job.GetProperty("status").GetString() == "running");
            _summary.Text = $"Ключей: {value.GetProperty("tokens").GetArrayLength()}  ·  Запросов: {value.GetProperty("approvals").GetArrayLength()}  ·  Команд: {Jobs}";
            var ui = value.GetProperty("settings").GetProperty("ui");
            _minimized.Checked = ui.TryGetProperty("startMinimized", out var minimized) && minimized.GetBoolean();
            SetTheme(ui.GetProperty("theme").GetString() != "light");
        }
        else { Jobs = 0; _tunnel.Text = "Туннель: нет данных"; _summary.Text = "Откройте окно для проверки подключения"; }
        _copy.Enabled = online && Uri.TryCreate(_url, UriKind.Absolute, out var parsed) && parsed.Scheme == "https";
        _icon.Text = online ? "TMCP · сервер работает\n" + _tunnel.Text : "TMCP · нет связи с сервером";
    }

    internal void SetStartup(bool enabled) => _startup.Checked = enabled;
    internal void SetBusy(bool busy, string? text = null)
    {
        _busy = busy;
        _restart.Enabled = _startup.Enabled = _minimized.Enabled = !busy;
        if (text != null) { _server.Text = text; _icon.Text = "TMCP · " + text[..Math.Min(text.Length, 50)]; }
    }
    internal void CopyLink() { if (_url != null) Clipboard.SetText(_url); }
    internal void ShowMenu(Point location) => _menu.Show(location);
    internal void Notify(string title, string text, bool error = false) => _icon.ShowBalloonTip(5000, title, text, error ? ToolTipIcon.Warning : ToolTipIcon.Info);
    internal void SetTheme(bool dark)
    {
        var renderer = new TrayRenderer(dark);
        _menu.Renderer = renderer;
        foreach (var item in _menu.Items.OfType<ToolStripMenuItem>().Where(item => item.HasDropDownItems)) item.DropDown.Renderer = renderer;
    }

    public void Dispose()
    {
        _icon.Visible = false; _icon.Dispose(); _menu.Dispose();
        foreach (var image in _images) image.Dispose();
        _onlineIcon.Dispose(); _offlineIcon.Dispose();
    }

    private static Icon StatusIcon(Color color)
    {
        using var bitmap = new Bitmap(32, 32);
        using (var graphics = Graphics.FromImage(bitmap))
        {
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.DrawIcon(Program.AppIcon, new Rectangle(0, 0, 32, 32));
            using var outline = new SolidBrush(Color.FromArgb(23, 29, 37));
            using var dot = new SolidBrush(color);
            graphics.FillEllipse(outline, 18, 18, 14, 14); graphics.FillEllipse(dot, 20, 20, 10, 10);
        }
        var handle = bitmap.GetHicon();
        try { using var icon = Icon.FromHandle(handle); return (Icon)icon.Clone(); }
        finally { DestroyIcon(handle); }
    }

    private static Bitmap Glyph(string name)
    {
        var bitmap = new Bitmap(18, 18);
        using var graphics = Graphics.FromImage(bitmap);
        graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using var pen = new Pen(name == "exit" ? Color.FromArgb(231, 112, 104) : Color.FromArgb(125, 145, 164), 1.6f) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round };
        if (name == "exit") { graphics.DrawArc(pen, 3, 3, 12, 12, -50, 280); graphics.DrawLine(pen, 9, 1, 9, 8); }
        else if (name == "keys") { graphics.DrawEllipse(pen, 2, 2, 7, 7); graphics.DrawLines(pen, new[] { new Point(8, 8), new Point(15, 15), new Point(16, 12), new Point(13, 12) }); }
        else if (name == "restart") { graphics.DrawArc(pen, 3, 3, 12, 12, 35, 300); graphics.DrawLines(pen, new[] { new Point(11, 2), new Point(15, 3), new Point(14, 7) }); }
        else if (name == "copy") { graphics.DrawRectangle(pen, 6, 5, 9, 11); graphics.DrawLines(pen, new[] { new Point(11, 3), new Point(3, 3), new Point(3, 12) }); }
        else if (name == "folder") { graphics.DrawLines(pen, new[] { new Point(2, 14), new Point(2, 4), new Point(7, 4), new Point(9, 6), new Point(16, 6), new Point(16, 14), new Point(2, 14) }); }
        else if (name == "settings") { graphics.DrawEllipse(pen, 3, 3, 12, 12); graphics.DrawEllipse(pen, 7, 7, 4, 4); }
        else if (name == "open") { graphics.DrawRectangle(pen, 2, 3, 14, 10); graphics.DrawLine(pen, 9, 13, 9, 16); graphics.DrawLine(pen, 6, 16, 12, 16); }
        else { graphics.DrawRectangle(pen, 3, 2, 12, 14); for (var y = 5; y < 14; y += 4) graphics.DrawLine(pen, 6, y, 12, y); }
        return bitmap;
    }

    [DllImport("user32.dll")] private static extern bool DestroyIcon(IntPtr icon);
}

internal sealed class TrayRenderer(bool dark) : ToolStripProfessionalRenderer
{
    private readonly Color _background = dark ? Color.FromArgb(23, 29, 37) : Color.White;
    protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e) { e.Graphics.Clear(_background); }
    protected override void OnRenderImageMargin(ToolStripRenderEventArgs e) { }
    protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e)
    {
        if (!e.Item.Selected) return;
        using var brush = new SolidBrush(dark ? Color.FromArgb(40, 52, 66) : Color.FromArgb(231, 237, 245));
        e.Graphics.FillRectangle(brush, new Rectangle(Point.Empty, e.Item.Size));
    }
    protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
    {
        e.TextColor = e.Item.Name == "exit" ? dark ? Color.FromArgb(245, 145, 136) : Color.FromArgb(181, 49, 45)
            : e.Item.Enabled ? dark ? Color.FromArgb(237, 242, 247) : Color.FromArgb(23, 33, 46)
            : dark ? Color.FromArgb(168, 180, 195) : Color.FromArgb(77, 92, 110);
        base.OnRenderItemText(e);
    }
    protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e)
    { using var pen = new Pen(dark ? Color.FromArgb(48, 61, 75) : Color.FromArgb(218, 226, 237)); e.Graphics.DrawLine(pen, 8, 3, e.Item.Width - 8, 3); }
}
