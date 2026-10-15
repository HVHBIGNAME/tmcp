using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace PcMcp;

internal static class InstallerStartup
{
    internal static async Task WaitAsync(Process process, string directory, CancellationToken cancellation, TimeSpan? timeout = null)
    {
        var elapsed = Stopwatch.StartNew();
        // Leave time to stop the backend inside the 60-second maintenance lease.
        var limit = timeout ?? TimeSpan.FromSeconds(45);
        while (true)
        {
            cancellation.ThrowIfCancellationRequested();
            if (process.HasExited)
                throw new IOException($"Установщик завершился до готовности (код {process.ExitCode}). {Details(directory)}");
            if (File.Exists(Path.Combine(directory, "installer.ready"))) return;
            if (elapsed.Elapsed >= limit)
                throw new TimeoutException($"Установщик не сообщил о готовности за {limit.TotalSeconds:g} с. {Details(directory)}");
            await Task.Delay(100, cancellation);
        }
    }

    internal static string Details(string directory)
    {
        try
        {
            using var file = new FileStream(Path.Combine(directory, "installer-state.json"), FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            if (file.Length > 16384) return "Диагностика установщика превышает лимит.";
            using var state = JsonDocument.Parse(file);
            var root = state.RootElement;
            var phase = root.GetProperty("phase").GetString() ?? "unknown";
            var message = root.TryGetProperty("message", out var value) ? value.GetString() ?? "" : "";
            return $"Этап: {phase[..Math.Min(phase.Length, 100)]}. {message[..Math.Min(message.Length, 2048)]}";
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or KeyNotFoundException or InvalidOperationException)
        { return "Диагностика установщика недоступна."; }
    }

    internal static void PreserveFailure(string home, UpdatePlan plan, Exception error)
    {
        var root = Path.Combine(home, ".updates");
        var temporary = Path.Combine(root, Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            var message = error.Message;
            var record = new { version = plan.Release.Version, at = DateTime.UtcNow, error = message[..Math.Min(message.Length, 4096)], diagnostic = Details(plan.Directory) };
            File.WriteAllText(temporary, JsonSerializer.Serialize(record), new UTF8Encoding(false));
            File.Move(temporary, Path.Combine(root, "last-installer-error.json"), true);
        }
        catch (Exception failure) when (failure is IOException or UnauthorizedAccessException) { Program.Log(failure); }
        finally
        {
            try { File.Delete(temporary); }
            catch (Exception failure) when (failure is IOException or UnauthorizedAccessException) { Program.Log(failure); }
        }
    }
}
