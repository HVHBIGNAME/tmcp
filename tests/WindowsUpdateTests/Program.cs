using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using PcMcp;

var failures = 0;
async Task Case(string name, Func<string, Task> run)
{
    var home = Path.Combine(Path.GetTempPath(), "tmcp-update-state-" + Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(home);
    try { await run(home); Console.WriteLine("PASS " + name); }
    catch (Exception error) { failures++; Console.Error.WriteLine($"FAIL {name}: {error.Message}"); }
    finally { Directory.Delete(home, true); }
}
void Check(bool value, string message) { if (!value) throw new Exception(message); }
WindowsUpdates Manager(string home, ReleaseHandler handler) => new(home, "2.1.0", true, _ => { }, _ => Task.FromResult(false), new HttpClient(handler));

foreach (var receipt in new[] { "null", "{\"status\":17}", "{\"status\":\"failed\",\"version\":{}}" })
    await Case("malformed receipt " + receipt, home =>
    {
        Directory.CreateDirectory(Path.Combine(home, ".updates"));
        File.WriteAllText(Path.Combine(home, ".updates", "status.json"), receipt);
        using var updates = Manager(home, new ReleaseHandler());
        Check(updates.State.Supported, "A damaged update receipt disabled application startup");
        return Task.CompletedTask;
    });

await Case("manual check reuses a verified pending download", async home =>
{
    var handler = new ReleaseHandler();
    using var updates = Manager(home, handler);
    await updates.CheckAsync(false);
    Check(updates.State.Status == "waiting", "Expected a verified pending update");
    var candidate = Directory.GetFiles(Path.Combine(home, ".updates"), "TMCP.exe", SearchOption.AllDirectories).Single();
    await updates.CheckAsync(true);
    Check(handler.Downloads == 1, "Manual check downloaded the same EXE again");
    Check(File.Exists(candidate), "Manual check deleted the verified candidate");
    await updates.TickAsync(false);
    Check(updates.State.Status == "waiting", "Explicit manual installation was cancelled by the automatic preference");
});

await Case("disabling automatic updates removes a pending download", async home =>
{
    using var updates = Manager(home, new ReleaseHandler());
    await updates.CheckAsync(false);
    await updates.TickAsync(false);
    Check(updates.State.Status == "disabled", "Automatic updates did not stop");
    Check(Directory.GetFiles(home, "TMCP.exe", SearchOption.AllDirectories).Length == 0, "Cancelled candidate was retained");
});

await Case("failed receipt does not claim rollback succeeded", home =>
{
    Directory.CreateDirectory(Path.Combine(home, ".updates"));
    File.WriteAllText(Path.Combine(home, ".updates", "status.json"), "{\"status\":\"failed\",\"version\":\"2.1.1\",\"message\":\"Rollback failed\"}");
    using var updates = Manager(home, new ReleaseHandler());
    Check(!updates.State.Message.Contains("восстановлена"), "UI incorrectly claimed the previous executable was restored");
    return Task.CompletedTask;
});

await Case("cancelling a partial download allows a clean retry", async home =>
{
    var blocked = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
    var handler = new ReleaseHandler { DownloadContent = bytes => new StreamContent(new BlockAfterChunk(bytes, blocked)) };
    using var updates = Manager(home, handler);
    var checking = updates.CheckAsync(false);
    await blocked.Task.WaitAsync(TimeSpan.FromSeconds(5));
    Check(Directory.GetFiles(home, "*.part", SearchOption.AllDirectories).Length == 1, "Expected an active partial download");
    await updates.TickAsync(false);
    await checking.WaitAsync(TimeSpan.FromSeconds(5));
    await updates.TickAsync(false);
    Check(updates.State.Status == "disabled", "Cancellation did not settle in disabled state");
    Check(Directory.GetFiles(home, "*.part", SearchOption.AllDirectories).Length == 0, "Cancellation left a partial file");
    handler.DownloadContent = null;
    await updates.CheckAsync(true);
    Check(updates.State.Status == "waiting" && handler.Downloads == 2, "Manual retry did not finish successfully");
});

await Case("manual check discards a withdrawn pending release", async home =>
{
    var handler = new ReleaseHandler();
    using var updates = Manager(home, handler);
    await updates.CheckAsync(false);
    handler.Version = "2.1.0";
    await updates.CheckAsync(true);
    Check(updates.State.Status == "current" && updates.State.AvailableVersion == null, "Withdrawn version remained available");
    Check(Directory.GetFiles(home, "TMCP.exe", SearchOption.AllDirectories).Length == 0, "Withdrawn candidate remained installable");
});

await Case("failed version waits for an explicit retry", async home =>
{
    Directory.CreateDirectory(Path.Combine(home, ".updates"));
    File.WriteAllText(Path.Combine(home, ".updates", "status.json"), "{\"status\":\"failed\",\"version\":\"2.1.1\"}");
    var handler = new ReleaseHandler();
    using var updates = Manager(home, handler);
    await updates.CheckAsync(false);
    Check(updates.State.Status == "failed" && handler.Downloads == 0, "Failed version was automatically retried");
    await updates.CheckAsync(true);
    Check(updates.State.Status == "waiting" && handler.Downloads == 1, "Explicit retry did not download the update");
});
await Case("active installer retains its candidate and failure diagnostics survive cleanup", async home =>
{
    var entered = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
    var release = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
    using var updates = new WindowsUpdates(home, "2.1.0", true, _ => { }, async plan =>
    {
        File.WriteAllText(Path.Combine(plan.Directory, "installer-state.json"), "{\"phase\":\"verifying-download\",\"message\":\"fixture failure\"}");
        entered.SetResult(true);
        await release.Task;
        Check(File.Exists(plan.Candidate), "Disabling updates deleted a candidate still used by the installer");
        throw new IOException("fixture startup error");
    }, new HttpClient(new ReleaseHandler()));
    await updates.CheckAsync(false);
    var installing = updates.TickAsync(true);
    await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
    try { await updates.TickAsync(false); }
    finally { release.TrySetResult(true); }
    await installing;
    Check(updates.State.Status == "failed", "Installer failure was not reported");
    var saved = File.ReadAllText(Path.Combine(home, ".updates", "last-installer-error.json"));
    Check(saved.Contains("verifying-download") && saved.Contains("fixture startup error"), "Failure diagnostics were deleted with the candidate");
    Check(Directory.GetFiles(home, "TMCP.exe", SearchOption.AllDirectories).Length == 0, "Failed candidate was not cleaned up");
});
await InstallerStartupTests.Run(Case);
Environment.ExitCode = failures == 0 ? 0 : 1;

sealed class ReleaseHandler : HttpMessageHandler
{
    private readonly byte[] _bytes = { 77, 90, 1, 2, 3, 4 };
    public int Downloads { get; private set; }
    public string Version { get; set; } = "2.1.1";
    public Func<byte[], HttpContent>? DownloadContent { get; set; }
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        if (request.RequestUri!.AbsoluteUri == UpdateClient.LatestUrl)
        {
            var metadata = new { tag_name = "v" + Version, draft = false, prerelease = false, assets = new[] { new {
                name = "TMCP.exe", browser_download_url = $"https://github.com/HVHBIGNAME/tmcp/releases/download/v{Version}/TMCP.exe",
                digest = "sha256:" + Convert.ToHexString(SHA256.HashData(_bytes)).ToLowerInvariant(), size = _bytes.Length,
            } } };
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(JsonSerializer.SerializeToUtf8Bytes(metadata)) });
        }
        Downloads++;
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = DownloadContent?.Invoke(_bytes) ?? new ByteArrayContent(_bytes) });
    }
}

sealed class BlockAfterChunk(byte[] bytes, TaskCompletionSource<bool> blocked) : MemoryStream(bytes)
{
    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        if (Position == 0) return await base.ReadAsync(buffer[..3], cancellationToken);
        blocked.TrySetResult(true);
        await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
        return 0;
    }
}
