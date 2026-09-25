using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace JobPilot.Terminal.Workers;

public sealed class WorkerHandoffApi : IWorkerHandoffApi, IDisposable
{
    private readonly WorkerOptions options;
    private readonly HttpClient http;
    public WorkerHandoffApi(WorkerOptions options)
        : this(options, new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(10) }) { }
    internal WorkerHandoffApi(WorkerOptions options, HttpClient http) { this.options = options; this.http = http; }

    public async Task<WorkerHandoffSnapshot?> GetAsync(WorkerIdentity identity, string attemptId, CancellationToken ct)
        => await SendAsync(identity, WorkerHandoffValidation.Id(attemptId), null, null, ct);

    public async Task<WorkerHandoffSnapshot> TransitionAsync(WorkerIdentity identity, WorkerHandoffSnapshot current, string action, CancellationToken ct, string? proofHash = null)
    {
        if (action is not ("open" or "heartbeat" or "resume" or "cancel")) throw new WorkerRequestException("Unsupported handoff action.");
        if (action == "resume" && (proofHash is null || proofHash.Length != 64 || proofHash.Any(c => !char.IsAsciiHexDigitLower(c))))
            throw new WorkerRequestException("A verified browser handoff proof is required.", 409);
        var next = await SendAsync(identity, current.AttemptId, action,
            new(current.HandoffId, current.LeaseOwner, current.LeaseGeneration, proofHash), ct)
            ?? throw new WorkerRequestException("Browser handoff was not found.", 404);
        WorkerHandoffValidation.SameScope(current, next, opening: action == "open");
        return next;
    }

    private async Task<WorkerHandoffSnapshot?> SendAsync(WorkerIdentity identity, string attemptId, string? action, WorkerHandoffLease? lease, CancellationToken ct)
    {
        var path = "/api/personal/attempts/" + attemptId + "/handoff" + (action is null ? "" : "/" + action);
        using var request = new HttpRequestMessage(action is null ? HttpMethod.Get : HttpMethod.Post, new Uri(options.PrivateApiOrigin(), path));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", identity.Bearer);
        if (lease is not null) request.Content = new StringContent(JsonSerializer.Serialize(lease, WorkerJsonContext.Default.WorkerHandoffLease), Encoding.UTF8, "application/json");
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        if (response.StatusCode == HttpStatusCode.NotFound) return null;
        if (!response.IsSuccessStatusCode) throw new WorkerRequestException("Private API refused the browser handoff action.", response.StatusCode is HttpStatusCode.Conflict or HttpStatusCode.Forbidden ? 409 : 503);
        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var bytes = new MemoryStream();
        var buffer = new byte[4096];
        int read;
        while ((read = await stream.ReadAsync(buffer, ct)) != 0)
        {
            if (bytes.Length + read > 16 * 1024) throw new WorkerRequestException("Private API handoff response exceeded its limit.", 502);
            bytes.Write(buffer, 0, read);
        }
        var value = JsonSerializer.Deserialize(bytes.ToArray(), WorkerJsonContext.Default.WorkerHandoffSnapshot)
            ?? throw new WorkerRequestException("Private API returned no handoff scope.", 502);
        return WorkerHandoffValidation.Check(value, attemptId);
    }
    public void Dispose() => http.Dispose();
}
