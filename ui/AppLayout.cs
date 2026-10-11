using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace PcMcp;

internal sealed record PayloadInfo(string Version, string Sha256, string Node, string Webview);

internal sealed class AppLayout
{
    internal string Home { get; }
    internal string Project { get; }
    internal string EnvFile => Path.Combine(Home, ".env");
    internal string Executable => Bundled ? Path.Combine(Home, "TMCP.exe") : Environment.ProcessPath!;
    internal string Data => Path.GetFullPath(Environment.GetEnvironmentVariable("PC_MCP_UI_DATA_DIR") ?? ReadVariable("MCP_DATA_DIR") ?? ".mcp-tunnel", Home);
    internal PayloadInfo? Payload { get; }
    internal bool Bundled => Payload != null;
    internal string? Browser => Bundled ? Path.Combine(Project, "browser-runtime") : null;
    internal string Version => Payload?.Version ?? Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "2.0.0";

    internal AppLayout(string? requestedHome, bool preview)
    {
        var assembly = Assembly.GetExecutingAssembly();
        using var stream = preview ? null : assembly.GetManifestResourceStream("PcMcp.Payload.json");
        if (stream != null)
        {
            Payload = JsonSerializer.Deserialize<PayloadInfo>(stream, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
                ?? throw new InvalidDataException("The embedded runtime manifest is missing.");
            if (Payload.Sha256.Length != 64 || Payload.Sha256.Any(c => !Uri.IsHexDigit(c)))
                throw new InvalidDataException("Invalid embedded runtime digest.");
        }
        Home = Path.GetFullPath(requestedHome ?? (Bundled
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TMCP") : FindProject()));
        Project = Bundled ? Path.Combine(Home, "app", Payload!.Sha256[..20]) : Home;
    }

    private static string FindProject()
    {
        var current = new DirectoryInfo(AppContext.BaseDirectory);
        for (var i = 0; current != null && i < 7; i++, current = current.Parent)
            if (File.Exists(Path.Combine(current.FullName, "package.json"))) return current.FullName;
        throw new DirectoryNotFoundException("Use the standalone TMCP.exe or build inside the source project.");
    }

    internal string? ReadVariable(string name)
    {
        var inherited = Environment.GetEnvironmentVariable(name);
        if (inherited != null) return inherited;
        if (!File.Exists(EnvFile)) return null;
        foreach (var line in File.ReadLines(EnvFile))
        {
            var parts = line.Trim().Split('=', 2);
            if (parts.Length != 2 || parts[0].Trim() != name) continue;
            var value = parts[1].Trim();
            if (value.Length >= 2 && (value[0] == '\'' || value[0] == '"') && value[^1] == value[0]) return value[1..^1];
            return value.Split('#', 2)[0].Trim();
        }
        return null;
    }

    internal bool StartMinimized()
    {
        var filename = Path.Combine(Data, "settings.json");
        if (!File.Exists(filename)) return false;
        using var json = JsonDocument.Parse(File.ReadAllText(filename));
        return json.RootElement.TryGetProperty("ui", out var ui) && ui.TryGetProperty("startMinimized", out var value) && value.ValueKind == JsonValueKind.True;
    }

    internal async Task PrepareAsync(IProgress<string> progress, CancellationToken cancellation)
    {
        if (!Bundled) return;
        Directory.CreateDirectory(Home);
        Directory.CreateDirectory(Data);
        var marker = Path.Combine(Project, "payload.ready");
        var required = new[] { "runtime/node.exe", "bin/cloudflared.exe", "browser-runtime/msedgewebview2.exe", "dist/src/main.js", "ui/public/index.html", "node_modules/@modelcontextprotocol/sdk/package.json" };
        var ready = File.Exists(marker) && File.ReadAllText(marker) == Payload!.Sha256 && required.All(file => File.Exists(Path.Combine(Project, file)));
        if (!ready)
        {
            progress.Report("Подготавливаем встроенные компоненты. Это нужно только при первом запуске версии…");
            await Task.Run(() => Extract(progress, cancellation), cancellation);
        }
        if (!File.Exists(EnvFile))
        {
            var root = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile).Replace('\\', '/');
            var port = Environment.GetEnvironmentVariable("MCP_PORT") ?? "18787";
            if (!int.TryParse(port, out var number) || number is < 1024 or > 65535) throw new ArgumentException("Invalid MCP port.");
            var config = $"MCP_PORT={number}\nMCP_ROOTS={JsonSerializer.Serialize(new[] { root })}\nMCP_ENABLE_SHELL=true\nMCP_ENABLE_SCREENSHOTS=true\nMCP_GATEWAY_DISCOVER=true\nMCP_GATEWAY_MODE=catalog\n";
            await using var file = new FileStream(EnvFile, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            await file.WriteAsync(Encoding.UTF8.GetBytes(config), cancellation);
        }
        var metadata = JsonSerializer.Serialize(new { version = Payload!.Version, project = Project,
            node = Path.Combine(Project, "runtime", "node.exe"), cli = Path.Combine(Project, "dist", "src", "cli.js"), envFile = EnvFile, data = Data });
        var temporary = Path.Combine(Home, ".application-" + Guid.NewGuid().ToString("N") + ".tmp");
        try { await File.WriteAllTextAsync(temporary, metadata, cancellation); File.Move(temporary, Path.Combine(Home, "application.json"), true); }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
        InstallExecutable();
        progress.Report("Запускаем локальный сервер…");
    }

    private void InstallExecutable()
    {
        if (string.Equals(Environment.ProcessPath, Executable, StringComparison.OrdinalIgnoreCase)) return;
        if (File.Exists(Executable))
        {
            var existing = FileVersionInfo.GetVersionInfo(Executable);
            if (existing.ProductName != "TMCP Desktop") throw new IOException("The installation contains an unrelated TMCP.exe.");
            if (System.Version.TryParse(existing.FileVersion, out var installed) && installed >= UpdateClient.ParseVersion(Payload!.Version)) return;
        }
        var temporary = Path.Combine(Home, ".TMCP-" + Guid.NewGuid().ToString("N") + ".exe");
        try { File.Copy(Environment.ProcessPath!, temporary); File.Move(temporary, Executable, true); }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    private void Extract(IProgress<string> progress, CancellationToken cancellation)
    {
        var parent = Path.GetDirectoryName(Project)!;
        Directory.CreateDirectory(parent);
        var staging = Path.Combine(parent, ".extract-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(staging);
        try
        {
            using var source = Assembly.GetExecutingAssembly().GetManifestResourceStream("PcMcp.Payload.zip")
                ?? throw new InvalidDataException("The embedded runtime archive is missing.");
            if (Convert.ToHexString(SHA256.HashData(source)).ToLowerInvariant() != Payload!.Sha256)
                throw new InvalidDataException("The embedded runtime checksum does not match.");
            source.Position = 0;
            using var archive = new ZipArchive(source, ZipArchiveMode.Read);
            var prefix = Path.GetFullPath(staging) + Path.DirectorySeparatorChar;
            for (var index = 0; index < archive.Entries.Count; index++)
            {
                cancellation.ThrowIfCancellationRequested();
                var entry = archive.Entries[index];
                var destination = Path.GetFullPath(Path.Combine(staging, entry.FullName));
                if (!destination.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Invalid runtime archive path.");
                if (entry.FullName.EndsWith('/') || entry.FullName.EndsWith('\\')) { Directory.CreateDirectory(destination); continue; }
                Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                entry.ExtractToFile(destination);
                if (index % 150 == 0) progress.Report($"Подготавливаем компоненты: {index * 100 / archive.Entries.Count}%");
            }
            GrantBrowserReadAccess(Path.Combine(staging, "browser-runtime"));
            File.WriteAllText(Path.Combine(staging, "payload.ready"), Payload.Sha256);
            if (Directory.Exists(Project)) Directory.Move(Project, Project + ".incomplete-" + Guid.NewGuid().ToString("N"));
            Directory.Move(staging, Project);
        }
        finally { if (Directory.Exists(staging)) Directory.Delete(staging, true); }
    }

    private static void GrantBrowserReadAccess(string directory)
    {
        var info = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "icacls.exe"))
        { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var arg in new[] { directory, "/grant", "*S-1-15-2-1:(OI)(CI)(RX)", "*S-1-15-2-2:(OI)(CI)(RX)" }) info.ArgumentList.Add(arg);
        using var process = Process.Start(info) ?? throw new IOException("Cannot configure the browser runtime.");
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(15000)) { process.Kill(); throw new TimeoutException("Browser permissions setup timed out."); }
        Task.WaitAll(output, error);
        if (process.ExitCode != 0) throw new IOException("Cannot grant the browser sandbox read access to its runtime.");
    }
}
