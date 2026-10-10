using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Web.WebView2.Core;

namespace PcMcp;

internal sealed class ControlBridge : IDisposable
{
    private readonly CoreWebView2 _web;
    private readonly HttpClient _http;
    private readonly Dictionary<string, CancellationTokenSource> _requests = new();
    private string? _stream;
    private bool _disposed;

    internal ControlBridge(CoreWebView2 web, HttpClient http) { _web = web; _http = http; }

    private void Send(object message)
    {
        if (!_disposed && Program.IsUiDocument(_web.Source))
            _web.PostWebMessageAsJson(JsonSerializer.Serialize(message));
    }

    internal async Task HandleAsync(JsonElement message)
    {
        if (_disposed || !message.TryGetProperty("id", out var identifier) ||
            identifier.ValueKind != JsonValueKind.String || !Guid.TryParseExact(identifier.GetString(), "D", out _)) return;
        var id = identifier.GetString()!;
        var type = message.GetProperty("type").GetString();
        if (type == "control-cancel") { if (_requests.TryGetValue(id, out var active)) active.Cancel(); return; }
        if (type is not ("control-request" or "control-subscribe")) return;
        if (_requests.ContainsKey(id) || _requests.Count >= 16)
        {
            Send(new { type = "control-response", id, status = 429, data = new { message = "Слишком много действий. Подождите немного." } });
            return;
        }
        var cancellation = new CancellationTokenSource();
        _requests.Add(id, cancellation);
        try
        {
            if (type == "control-subscribe")
            {
                if (_stream != null && _requests.TryGetValue(_stream, out var previous)) previous.Cancel();
                _stream = id;
                await EventsAsync(id, cancellation.Token);
            }
            else await RequestAsync(id, message, cancellation);
        }
        catch (OperationCanceledException) { Send(new { type = "control-response", id, status = 0, message = "Действие отменено или сервер не ответил вовремя." }); }
        catch (Exception error) when (error is HttpRequestException or IOException or JsonException or InvalidOperationException or ArgumentException)
        { Send(new { type = "control-response", id, status = 0, message = "Нет связи с локальным сервером. Подключение повторится автоматически." }); }
        finally
        {
            _requests.Remove(id);
            if (_stream == id) _stream = null;
            if (type == "control-subscribe") Send(new { type = "control-stream-end", id });
            cancellation.Dispose();
        }
    }

    private async Task RequestAsync(string id, JsonElement message, CancellationTokenSource cancellation)
    {
        var path = message.GetProperty("path").GetString() ?? "";
        var method = message.GetProperty("method").GetString() ?? "GET";
        if (!Regex.IsMatch(path, @"^/_control/(bootstrap|api/[A-Za-z0-9_/?=&.-]+)$") || path.Contains("..") ||
            method is not ("GET" or "POST" or "PATCH" or "DELETE") || path.EndsWith("/events", StringComparison.Ordinal))
        {
            Send(new { type = "control-response", id, status = 400, data = new { message = "Недопустимое действие управления." } });
            return;
        }
        cancellation.CancelAfter(TimeSpan.FromSeconds(path.Contains("/tunnel/") ? 105 : path.EndsWith("/autostart", StringComparison.Ordinal) ? 60 : 15));
        using var request = new HttpRequestMessage(new HttpMethod(method), path);
        if (message.TryGetProperty("body", out var body) && body.ValueKind == JsonValueKind.String)
        {
            var text = body.GetString()!;
            if (Encoding.UTF8.GetByteCount(text) > 256 * 1024) throw new ArgumentException("Request too large.");
            request.Content = new StringContent(text, Encoding.UTF8, "application/json");
        }
        using var response = await _http.SendAsync(request, cancellation.Token);
        object? data = null;
        if (response.StatusCode != System.Net.HttpStatusCode.NoContent && response.Content.Headers.ContentType?.MediaType == "application/json")
        {
            using var parsed = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellation.Token));
            data = parsed.RootElement.Clone();
        }
        Send(new { type = "control-response", id, status = (int)response.StatusCode, data });
    }

    private async Task EventsAsync(string id, CancellationToken cancellation)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, "/_control/api/events");
        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation);
        response.EnsureSuccessStatusCode();
        if (response.Content.Headers.ContentType?.MediaType != "text/event-stream") throw new IOException("Invalid event stream.");
        Send(new { type = "control-stream-open", id });
        using var reader = new StreamReader(await response.Content.ReadAsStreamAsync(cancellation));
        while (!cancellation.IsCancellationRequested)
        {
            var line = await reader.ReadLineAsync(cancellation);
            if (line == null) break;
            if (line.Length > 256 * 1024) throw new IOException("Event too large.");
            if (!line.StartsWith("data: ", StringComparison.Ordinal)) continue;
            using var parsed = JsonDocument.Parse(line[6..]);
            Send(new { type = "control-event", id, data = parsed.RootElement });
        }
    }

    internal void CancelAll() { foreach (var cancellation in _requests.Values.ToArray()) cancellation.Cancel(); }
    public void Dispose() { _disposed = true; CancelAll(); }
}
