using System.ComponentModel;
using System.IO.Pipes;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace PcMcp;

internal static class ControlPipe
{
    internal static HttpClient CreateClient()
    {
        var handler = new SocketsHttpHandler
        {
            UseProxy = false, UseCookies = false, AllowAutoRedirect = false,
            ConnectTimeout = TimeSpan.FromSeconds(3), MaxConnectionsPerServer = 20,
            PooledConnectionLifetime = TimeSpan.FromSeconds(30), ConnectCallback = ConnectAsync,
        };
        return new HttpClient(handler)
        {
            BaseAddress = new Uri("http://tmcp.local"), Timeout = Timeout.InfiniteTimeSpan,
            MaxResponseContentBufferSize = 4 * 1024 * 1024,
        };
    }

    private static async ValueTask<Stream> ConnectAsync(SocketsHttpConnectionContext context, CancellationToken cancellation)
    {
        if (context.DnsEndPoint.Host != "tmcp.local") throw new IOException("Invalid IPC destination.");
        var filename = Path.Combine(Program.DataDir, "ipc", "control.json");
        using var document = JsonDocument.Parse(await File.ReadAllTextAsync(filename, cancellation));
        var saved = document.RootElement;
        var endpoint = saved.GetProperty("endpoint").GetString() ?? "";
        const string prefix = @"\\.\pipe\tmcp-";
        if (saved.GetProperty("version").GetInt32() != 1 || !endpoint.StartsWith(prefix, StringComparison.Ordinal) ||
            !Guid.TryParseExact(endpoint[prefix.Length..], "D", out _))
            throw new IOException("Invalid local IPC descriptor.");
        var pid = saved.GetProperty("pid").GetUInt32();
        var pipe = new NamedPipeClientStream(".", endpoint[@"\\.\pipe\".Length..], PipeDirection.InOut,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly, TokenImpersonationLevel.Anonymous);
        try
        {
            await pipe.ConnectAsync(cancellation);
            if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out var serverPid))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            if (serverPid != pid) throw new IOException("The IPC server identity changed.");
            return pipe;
        }
        catch { pipe.Dispose(); throw; }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint serverProcessId);
}
