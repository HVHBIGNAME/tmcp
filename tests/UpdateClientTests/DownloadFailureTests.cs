using System.Net;
using PcMcp;

internal static class DownloadFailureTests
{
    internal static async Task Run(UpdateRelease release, byte[] bytes, string directory)
    {
        var errors = new List<Exception>();
        async Task Case(string name, Func<Task> action)
        {
            try { await action(); Console.WriteLine("PASS " + name); }
            catch (Exception error) { errors.Add(new Exception(name, error)); }
        }
        var destination = Path.Combine(directory, "failure-test.exe");
        var partial = destination + ".part";
        await Case("an existing partial file is never deleted by a second download", async () =>
        {
            File.WriteAllText(partial, "another download");
            using var http = new HttpClient(new FakeHandler(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(bytes) }));
            await Throws<IOException>(() => new UpdateClient(http).DownloadAsync(release, destination, new Progress<int>(), default));
            if (!File.Exists(partial) || File.ReadAllText(partial) != "another download") throw new Exception("Existing partial file was removed");
            File.Delete(partial);
        });
        if (File.Exists(partial)) File.Delete(partial);
        await Case("cancellation while closing the response cannot publish an EXE", async () =>
        {
            using var cancelled = new CancellationTokenSource();
            using var http = new HttpClient(new FakeHandler(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(new CancelOnClose(bytes, cancelled)) }));
            await Throws<OperationCanceledException>(() => new UpdateClient(http).DownloadAsync(release, destination, new Progress<int>(), cancelled.Token));
            if (File.Exists(destination) || File.Exists(partial)) throw new Exception("Cancelled download remained installable");
        });
        if (errors.Count != 0) throw new AggregateException(errors);
    }

    private static async Task Throws<T>(Func<Task> run) where T : Exception
    {
        try { await run(); }
        catch (T) { return; }
        throw new Exception("Expected " + typeof(T).Name);
    }

    private sealed class CancelOnClose(byte[] bytes, CancellationTokenSource cancelled) : MemoryStream(bytes)
    {
        public override ValueTask DisposeAsync() { cancelled.Cancel(); return base.DisposeAsync(); }
    }
}
