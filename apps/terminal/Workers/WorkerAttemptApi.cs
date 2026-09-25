using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace JobPilot.Terminal.Workers;

public interface IWorkerAttemptApi
{
    Task<bool> RenewAsync(WorkerIdentity identity, AgentTaskRequest task, CancellationToken ct);
    Task<bool> HasSubmissionReceiptAsync(WorkerIdentity identity, AgentTaskRequest task, CancellationToken ct);
    Task<bool> CancelAsync(WorkerIdentity identity, AgentTaskRequest task, CancellationToken ct);
}

public sealed class WorkerAttemptApi : IWorkerAttemptApi, IDisposable
{
    private readonly WorkerOptions options;
    private readonly HttpClient http;

    public WorkerAttemptApi(WorkerOptions options)
        : this(options, new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(10) }) { }

    internal WorkerAttemptApi(WorkerOptions options, HttpClient http)
    {
        this.options = options;
        this.http = http;
    }

    public async Task<bool> RenewAsync(WorkerIdentity identity, AgentTaskRequest task, CancellationToken ct)
    {
        using var request = LeaseRequest(identity, task, "/checkpoint");
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        if (response.IsSuccessStatusCode) return true;
        if (response.StatusCode != System.Net.HttpStatusCode.Conflict) return false;
        // Submitting has a fixed expiry: heartbeat must allow its receipt wait without extending that lease.
        using var read = Request(identity, task, HttpMethod.Get, "");
        using var snapshot = await http.SendAsync(read, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!snapshot.IsSuccessStatusCode) return false;
        using var document = JsonDocument.Parse(await snapshot.Content.ReadAsStringAsync(ct));
        var value = document.RootElement;
        if (HasReceipt(value, task)) return true;
        return SameAttempt(value, task)
            && value.TryGetProperty("state", out var state) && state.GetString() == "submitting"
            && value.TryGetProperty("leaseOwner", out var owner) && owner.GetString() == task.Input.GetProperty("leaseOwner").GetString()
            && value.TryGetProperty("leaseGeneration", out var generation) && generation.GetInt64() == task.Input.GetProperty("leaseGeneration").GetInt64()
            && value.TryGetProperty("leaseExpiresAt", out var expiry) && expiry.TryGetDateTimeOffset(out var until) && until > DateTimeOffset.UtcNow;
    }

    public async Task<bool> CancelAsync(WorkerIdentity identity, AgentTaskRequest task, CancellationToken ct)
        => await SendLeaseAsync(identity, task, "/cancel", ct);

    private async Task<bool> SendLeaseAsync(WorkerIdentity identity, AgentTaskRequest task, string suffix, CancellationToken ct)
    {
        using var request = LeaseRequest(identity, task, suffix);
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        return response.IsSuccessStatusCode;
    }

    private HttpRequestMessage LeaseRequest(WorkerIdentity identity, AgentTaskRequest task, string suffix)
    {
        var body = new JsonObject
        {
            ["leaseOwner"] = task.Input.GetProperty("leaseOwner").GetString(),
            ["leaseGeneration"] = task.Input.GetProperty("leaseGeneration").GetInt64(),
        };
        var request = Request(identity, task, HttpMethod.Post, suffix);
        request.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        return request;
    }

    public async Task<bool> HasSubmissionReceiptAsync(WorkerIdentity identity, AgentTaskRequest task, CancellationToken ct)
    {
        using var request = Request(identity, task, HttpMethod.Get, "");
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!response.IsSuccessStatusCode) return false;
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
        return HasReceipt(document.RootElement, task);
    }

    private static bool HasReceipt(JsonElement value, AgentTaskRequest task) => SameAttempt(value, task)
            && value.TryGetProperty("state", out var state) && state.GetString() == "submitted"
            && value.TryGetProperty("receipt", out var receipt) && receipt.ValueKind == JsonValueKind.Object
            && receipt.TryGetProperty("outcome", out var outcome) && outcome.GetString() == "submitted";

    private static bool SameAttempt(JsonElement value, AgentTaskRequest task) =>
        value.TryGetProperty("id", out var id) && id.GetString() == task.Input.GetProperty("attemptId").GetString();

    private HttpRequestMessage Request(WorkerIdentity identity, AgentTaskRequest task, HttpMethod method, string suffix)
    {
        var id = task.Input.GetProperty("attemptId").GetString()!;
        var request = new HttpRequestMessage(method, new Uri(options.PrivateApiOrigin(), "/api/personal/attempts/" + Uri.EscapeDataString(id) + suffix));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", identity.Bearer);
        return request;
    }

    public void Dispose() => http.Dispose();
}
