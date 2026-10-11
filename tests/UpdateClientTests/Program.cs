using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using PcMcp;

var bytes = new byte[] { 77, 90, 1, 2, 3, 4, 5, 6 };
var digest = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
const string expectedUrl = "https://github.com/HVHBIGNAME/tmcp/releases/download/v2.1.0/TMCP.exe";
object Release(string tag = "v2.1.0", string url = expectedUrl, string? sha = null, bool prerelease = false, long? size = null) =>
    new { tag_name = tag, draft = false, prerelease, assets = new[] { new { name = "TMCP.exe", browser_download_url = url, digest = sha ?? "sha256:" + digest, size = size ?? bytes.Length } } };
void Check(bool value, string message) { if (!value) throw new Exception(message); }
async Task Reject(Func<Task> operation)
{
    try { await operation(); }
    catch (InvalidDataException) { return; }
    throw new Exception("Unsafe update was not rejected");
}
object metadata = Release();
byte[] download = bytes;
using var http = new HttpClient(new FakeHandler(request =>
{
    if (request.RequestUri!.AbsoluteUri == UpdateClient.LatestUrl)
        return new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(JsonSerializer.SerializeToUtf8Bytes(metadata)) };
    Check(request.RequestUri.AbsoluteUri == expectedUrl, "Unexpected download destination");
    return new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(download) };
}));
var client = new UpdateClient(http);
var release = await client.LatestAsync("2.0.2", default) ?? throw new Exception("New version not detected");
Check(release.Version == "2.1.0" && release.Sha256 == digest, "Invalid release identity");
Check(await client.LatestAsync("2.1.0", default) == null, "Same version must not update");
Check(await client.LatestAsync("3.0.0", default) == null, "Downgrades must not update");
metadata = Release(prerelease: true);
Check(await client.LatestAsync("2.0.0", default) == null, "Prerelease must not update");
metadata = Release(url: "https://outside.example/TMCP.exe");
await Reject(async () => { await client.LatestAsync("2.0.0", default); });
metadata = Release(sha: "sha256:invalid");
await Reject(async () => { await client.LatestAsync("2.0.0", default); });
metadata = Release(size: 3L * 1024 * 1024 * 1024);
await Reject(async () => { await client.LatestAsync("2.0.0", default); });
metadata = Release(tag: "v2.1.0/../../bad");
await Reject(async () => { await client.LatestAsync("2.0.0", default); });
metadata = new { padding = new string('x', 1024 * 1024) };
await Reject(async () => { await client.LatestAsync("2.0.0", default); });
metadata = new { tag_name = "v2.1.0", draft = false, prerelease = false, assets = Array.Empty<object>() };
await Reject(async () => { await client.LatestAsync("2.0.0", default); });
var directory = Path.Combine(Path.GetTempPath(), "tmcp-update-client-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(directory);
try
{
    var filename = Path.Combine(directory, "TMCP.exe");
    await client.DownloadAsync(release, filename, new Progress<int>(), default);
    Check(File.ReadAllBytes(filename).SequenceEqual(bytes), "Verified bytes changed");
    File.Delete(filename);
    download = new byte[] { 77, 90, 9, 9, 9, 9, 9, 9 };
    await Reject(() => client.DownloadAsync(release, filename, new Progress<int>(), default));
    Check(!File.Exists(filename) && !File.Exists(filename + ".part"), "A rejected download was left installable");
    download = new byte[] { 77, 90 };
    await Reject(() => client.DownloadAsync(release, filename, new Progress<int>(), default));
    Check(Directory.GetFiles(directory).Length == 0, "Partial download was not removed");
}
finally { Directory.Delete(directory, true); }
Console.WriteLine("Update client verified: version ordering, stable releases, repository-bound URL, metadata limits, SHA-256 and partial-file cleanup.");

sealed class FakeHandler(Func<HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => Task.FromResult(respond(request));
}
