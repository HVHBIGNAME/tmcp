using System.Diagnostics;
using System.Net.Http;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;

namespace PcMcp;

internal sealed record UpdateStatus(bool Supported, string CurrentVersion, string? AvailableVersion, string Status, string Message, int Progress);
internal sealed record UpdatePlan(UpdateRelease Release, string Directory, string Candidate);

internal sealed class WindowsUpdates : IDisposable
{
    private readonly HttpClient _http;
    private readonly CancellationTokenSource _closed = new();
    private readonly Action<UpdateStatus> _changed;
    private readonly Func<UpdatePlan, Task<bool>> _install;
    private readonly string _home, _version;
    private CancellationTokenSource? _request;
    private DateTime _nextCheck = DateTime.UtcNow.AddSeconds(30);
    private string? _blocked;
    private bool _busy, _manual, _disposed;
    private UpdatePlan? _plan;
    internal UpdateStatus State { get; private set; }

    internal WindowsUpdates(string home, string version, bool supported, Action<UpdateStatus> changed, Func<UpdatePlan, Task<bool>> install, HttpClient? http = null)
    {
        _http = http ?? new HttpClient { Timeout = Timeout.InfiniteTimeSpan };
        _home = home; _version = version; _changed = changed; _install = install;
        State = new(supported, version, null, "idle", supported ? "Проверяем GitHub автоматически каждые 6 часов." : "Автообновление доступно в автономном Windows-приложении.", 0);
        var receipt = Path.Combine(home, ".updates", "status.json");
        if (supported && File.Exists(receipt))
        {
            try
            {
                if (new FileInfo(receipt).Length > 65536) throw new InvalidDataException("The update receipt is too large.");
                using var saved = JsonDocument.Parse(File.ReadAllText(receipt));
                if (saved.RootElement.GetProperty("status").GetString() == "failed")
                {
                    _blocked = saved.RootElement.GetProperty("version").GetString();
                    State = State with { Status = "failed", Message = "Последнее обновление завершилось ошибкой. Можно повторить проверку вручную." };
                }
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or KeyNotFoundException or InvalidOperationException) { Program.Log(error); }
        }
    }

    internal async Task TickAsync(bool enabled)
    {
        if (!State.Supported || _disposed) return;
        if (!enabled && !_manual)
        {
            _request?.Cancel();
            if (_plan != null) { DeletePlan(); Set("disabled", "Автообновления выключены."); }
            else if (!_busy && State.Status != "disabled") Set("disabled", "Автообновления выключены. Можно проверить и установить новую версию вручную.");
            return;
        }
        if (_busy) return;
        if (_plan != null)
        {
            _busy = true;
            try
            {
                if (await _install(_plan)) Set("installing", "Устанавливаем обновление и перезапускаем приложение…");
                else Set("waiting", "Обновление загружено. Ждём завершения команд, запросов и редактирования форм.", 100);
            }
            catch (Exception error) { Failed(error); DeletePlan(); }
            finally { _busy = false; }
        }
        else if (DateTime.UtcNow >= _nextCheck) _ = CheckAsync(false);
    }

    internal async Task CheckAsync(bool manual)
    {
        if (!State.Supported || _busy || _disposed) return;
        _busy = true; _manual = manual;
        _request?.Dispose();
        var request = _request = CancellationTokenSource.CreateLinkedTokenSource(_closed.Token);
        request.CancelAfter(TimeSpan.FromMinutes(15));
        string? directory = null;
        try
        {
            Set("checking", "Проверяем последнюю стабильную версию на GitHub…");
            var client = new UpdateClient(_http);
            using var metadataTimeout = CancellationTokenSource.CreateLinkedTokenSource(_request.Token);
            metadataTimeout.CancelAfter(TimeSpan.FromSeconds(30));
            var release = await client.LatestAsync(_version, metadataTimeout.Token);
            _nextCheck = DateTime.UtcNow.AddHours(6);
            if (release == null) { DeletePlan(); State = State with { AvailableVersion = null }; Set("current", "Установлена актуальная версия."); return; }
            if (release.Version == _blocked && !manual) { DeletePlan(); Set("failed", "Установка этой версии уже завершилась ошибкой. Ожидаем следующий релиз или ручную повторную попытку."); return; }
            State = State with { AvailableVersion = release.Version };
            if (_plan?.Release == release && File.Exists(_plan.Candidate))
            { Set("waiting", "Проверенное обновление уже загружено. Ждём завершения работы и редактирования форм.", 100); return; }
            DeletePlan();
            var root = Path.Combine(_home, ".updates");
            ProtectDirectory(root);
            directory = Path.Combine(root, Guid.NewGuid().ToString("N"));
            System.IO.Directory.CreateDirectory(directory);
            var candidate = Path.Combine(directory, "TMCP.exe");
            Set("downloading", $"Загружаем версию {release.Version}…");
            var progress = new Progress<int>(value =>
            {
                if (!_disposed && ReferenceEquals(_request, request) && !request.IsCancellationRequested && State.Status == "downloading")
                    Set("downloading", $"Загружаем версию {release.Version}: {value}%", value);
            });
            await client.DownloadAsync(release, candidate, progress, request.Token);
            _plan = new(release, directory, candidate); directory = null;
            Set("waiting", "SHA-256 проверен. Обновление установится автоматически, когда приложение освободится.", 100);
        }
        catch (OperationCanceledException) when (_closed.IsCancellationRequested || _request.IsCancellationRequested)
        { if (!_disposed) Set("idle", "Проверка или загрузка прервана. Следующая попытка будет выполнена автоматически."); _nextCheck = DateTime.UtcNow.AddHours(1); }
        catch (Exception error) { Failed(error); }
        finally
        {
            if (directory != null) DeleteDirectory(directory);
            _manual = manual && _plan != null;
            _busy = false;
        }
    }

    private void Failed(Exception error)
    { Program.Log(error); _manual = false; _nextCheck = DateTime.UtcNow.AddHours(1); Set("failed", "Не удалось обновиться: " + error.Message); }
    private void Set(string status, string message, int progress = 0)
    { State = State with { Status = status, Message = message, Progress = progress }; if (!_disposed) _changed(State); }
    private void DeletePlan()
    { var plan = _plan; _plan = null; if (plan != null) DeleteDirectory(plan.Directory); }
    private static void DeleteDirectory(string directory)
    {
        try { if (System.IO.Directory.Exists(directory)) System.IO.Directory.Delete(directory, true); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { Program.Log(error); }
    }

    internal static void ProtectDirectory(string path)
    {
        var directory = System.IO.Directory.CreateDirectory(path);
        if ((directory.Attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("The update directory must not be a link.");
        var acl = new DirectorySecurity();
        acl.SetAccessRuleProtection(true, false);
        var inherit = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
        foreach (var sid in new[] { WindowsIdentity.GetCurrent().User!, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null) })
            acl.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
        directory.SetAccessControl(acl);
    }

    internal static async Task<(Process Process, string Abort)> StartInstallerAsync(UpdatePlan plan, bool show, CancellationToken cancellation)
    {
        var layout = Program.Layout;
        var helper = Path.Combine(plan.Directory, "install.ps1");
        using var source = Assembly.GetExecutingAssembly().GetManifestResourceStream("PcMcp.update-install.ps1") ?? throw new IOException("Update installer is missing.");
        await using (var file = File.Create(helper)) await source.CopyToAsync(file, cancellation);
        var manifest = Path.Combine(plan.Directory, "plan.json");
        var abort = Path.Combine(plan.Directory, "abort");
        var value = new { home = layout.Home, candidate = plan.Candidate, sha256 = plan.Release.Sha256, version = plan.Release.Version,
            oldPid = Environment.ProcessId, oldExecutable = Environment.ProcessPath, node = Path.Combine(layout.Project, "runtime", "node.exe"),
            cli = Path.Combine(layout.Project, "dist", "src", "cli.js"), envFile = layout.EnvFile, data = Program.DataDir, show, local = Program.LocalOnly };
        await File.WriteAllTextAsync(manifest, JsonSerializer.Serialize(value), new UTF8Encoding(false), cancellation);
        var info = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe")) { UseShellExecute = false, CreateNoWindow = true };
        foreach (var arg in new[] { "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "-Manifest", manifest }) info.ArgumentList.Add(arg);
        info.Environment["PSModulePath"] = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "Modules");
        var process = Process.Start(info) ?? throw new IOException("Cannot start the update installer.");
        try
        {
            var deadline = DateTime.UtcNow.AddSeconds(15);
            while (!File.Exists(Path.Combine(plan.Directory, "installer.ready")))
            {
                if (process.HasExited || DateTime.UtcNow > deadline) throw new IOException("The update installer did not become ready.");
                await Task.Delay(100, cancellation);
            }
            return (process, abort);
        }
        catch { await File.WriteAllTextAsync(abort, "abort", CancellationToken.None); if (!process.HasExited) process.Kill(); process.Dispose(); throw; }
    }

    public void Dispose() { _disposed = true; _closed.Cancel(); _request?.Cancel(); _http.Dispose(); }
}
