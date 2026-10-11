using System.Net.Http;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace PcMcp;

internal sealed record UpdateRelease(string Version, string Url, string Sha256, long Size);

internal sealed class UpdateClient(HttpClient http)
{
    internal const string Repository = "HVHBIGNAME/tmcp";
    internal const string LatestUrl = "https://api.github.com/repos/" + Repository + "/releases/latest";

    internal static Version ParseVersion(string value)
    {
        if (!Regex.IsMatch(value, @"^\d+\.\d+\.\d+$") || !Version.TryParse(value, out var version))
            throw new InvalidDataException("Invalid release version.");
        return new Version(version.Major, version.Minor, version.Build);
    }

    internal async Task<UpdateRelease?> LatestAsync(string current, CancellationToken cancellation)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, LatestUrl);
        request.Headers.UserAgent.ParseAdd("TMCP/" + current);
        request.Headers.Accept.ParseAdd("application/vnd.github+json");
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation);
        response.EnsureSuccessStatusCode();
        if (response.Content.Headers.ContentLength > 1024 * 1024) throw new InvalidDataException("Release metadata is too large.");
        await using var input = await response.Content.ReadAsStreamAsync(cancellation);
        using var bytes = new MemoryStream();
        var buffer = new byte[16384];
        int count;
        while ((count = await input.ReadAsync(buffer, cancellation)) != 0)
        {
            if (bytes.Length + count > 1024 * 1024) throw new InvalidDataException("Release metadata is too large.");
            bytes.Write(buffer, 0, count);
        }
        using var document = JsonDocument.Parse(bytes.ToArray());
        var release = document.RootElement;
        if (release.GetProperty("draft").GetBoolean() || release.GetProperty("prerelease").GetBoolean()) return null;
        var tag = release.GetProperty("tag_name").GetString() ?? "";
        if (!tag.StartsWith('v')) throw new InvalidDataException("Invalid release tag.");
        var version = tag[1..];
        if (ParseVersion(version) <= ParseVersion(current)) return null;
        var assets = release.GetProperty("assets").EnumerateArray().Where(asset => asset.GetProperty("name").GetString() == "TMCP.exe").ToArray();
        if (assets.Length != 1) throw new InvalidDataException("The release must contain one TMCP.exe.");
        var asset = assets[0];
        var url = asset.GetProperty("browser_download_url").GetString() ?? "";
        if (url != $"https://github.com/{Repository}/releases/download/{tag}/TMCP.exe")
            throw new InvalidDataException("The update is outside the configured GitHub repository.");
        var digest = asset.GetProperty("digest").GetString() ?? "";
        if (!Regex.IsMatch(digest, "^sha256:[a-f0-9]{64}$")) throw new InvalidDataException("The release has no SHA-256 digest.");
        var size = asset.GetProperty("size").GetInt64();
        if (size < 2 || size > 2L * 1024 * 1024 * 1024) throw new InvalidDataException("Invalid update size.");
        return new UpdateRelease(version, url, digest[7..], size);
    }

    internal async Task DownloadAsync(UpdateRelease release, string destination, IProgress<int> progress, CancellationToken cancellation)
    {
        using var response = await http.GetAsync(release.Url, HttpCompletionOption.ResponseHeadersRead, cancellation);
        response.EnsureSuccessStatusCode();
        if (response.Content.Headers.ContentLength is { } length && length != release.Size)
            throw new InvalidDataException("Update length differs from the GitHub release.");
        var temporary = destination + ".part";
        try
        {
            await using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            await using (var input = await response.Content.ReadAsStreamAsync(cancellation))
            using (var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256))
            {
                var buffer = new byte[65536];
                long total = 0;
                var previous = -1;
                int count;
                while ((count = await input.ReadAsync(buffer, cancellation)) != 0)
                {
                    total += count;
                    if (total > release.Size) throw new InvalidDataException("Update exceeded its declared size.");
                    hash.AppendData(buffer, 0, count);
                    await output.WriteAsync(buffer.AsMemory(0, count), cancellation);
                    var percent = (int)(total * 100 / release.Size);
                    if (percent != previous) { previous = percent; progress.Report(percent); }
                }
                if (total != release.Size || Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant() != release.Sha256)
                    throw new InvalidDataException("The downloaded update failed SHA-256 verification.");
                await output.FlushAsync(cancellation);
            }
            using (var input = File.OpenRead(temporary))
                if (input.ReadByte() != 'M' || input.ReadByte() != 'Z') throw new InvalidDataException("The update is not a Windows executable.");
            File.Move(temporary, destination);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
}
