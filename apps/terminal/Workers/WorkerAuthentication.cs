using System.Net.Http.Headers;
using System.Text.Json;

namespace JobPilot.Terminal.Workers;

public interface IWorkerAuthentication
{
    Task<WorkerIdentity?> AuthenticateAsync(string authorization, CancellationToken ct);
}

public sealed class WorkerAuthentication(WorkerOptions options) : IWorkerAuthentication, IDisposable
{
    private readonly HttpClient http = new(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(10) };

    public async Task<WorkerIdentity?> AuthenticateAsync(string authorization, CancellationToken ct)
    {
        if (!AuthenticationHeaderValue.TryParse(authorization, out var header)
            || !header.Scheme.Equals("Bearer", StringComparison.OrdinalIgnoreCase)
            || string.IsNullOrWhiteSpace(header.Parameter)) return null;

        using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(options.PrivateApiOrigin(), "/api/user"));
        request.Headers.Authorization = header;
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!response.IsSuccessStatusCode) return null;
        var content = await response.Content.ReadAsStringAsync(ct);
        if (content.Length > 1024 * 1024) throw new WorkerRequestException("Private API identity response exceeded its limit.", 502);
        using var body = JsonDocument.Parse(content);
        if (!body.RootElement.TryGetProperty("user", out var user) || user.ValueKind != JsonValueKind.Object
            || !user.TryGetProperty("id", out var id) || id.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(id.GetString())) return null;
        return new WorkerIdentity(id.GetString()!, header.Parameter);
    }

    public void Dispose() => http.Dispose();
}
