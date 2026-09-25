using System.Text.Json.Serialization;

namespace JobPilot.Terminal.Workers;

// This transport never contains page content, credentials, document paths or applicant answers.
public sealed record WorkerHandoffSnapshot
{
    public required string HandoffId { get; init; }
    public required string AttemptId { get; init; }
    public required string RecordId { get; init; }
    public required string ProfileKey { get; init; }
    public required string AllowedOrigin { get; init; }
    public required string Reason { get; init; }
    public required string Status { get; init; }
    public required string LeaseOwner { get; init; }
    public required long LeaseGeneration { get; init; }
    public required DateTimeOffset LeaseExpiresAt { get; init; }
    public string? TaskId { get; init; }
    public DateTimeOffset UpdatedAt { get; init; } = DateTimeOffset.UtcNow;
    public bool BrowserOpen { get; init; }
    public AgentTaskEvent[] Events { get; init; } = [];
}

public sealed record WorkerHandoffLease(string HandoffId, string LeaseOwner, long LeaseGeneration,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ProofHash = null);

public interface IWorkerHandoffApi
{
    Task<WorkerHandoffSnapshot?> GetAsync(WorkerIdentity identity, string attemptId, CancellationToken ct);
    Task<WorkerHandoffSnapshot> TransitionAsync(WorkerIdentity identity, WorkerHandoffSnapshot current, string action, CancellationToken ct, string? proofHash = null);
}

public interface IWorkerHandoffBrowser : IAsyncDisposable
{
    Task OpenAsync(CancellationToken ct);
    bool IsRunning { get; }
    Task<string?> ResumeAsync(CancellationToken ct);
    Task CloseAsync(CancellationToken ct);
}

public interface IWorkerHandoffBrowserFactory
{
    IWorkerHandoffBrowser Create(WorkerIdentity identity, WorkerHandoffSnapshot handoff, string workingDirectory);
}

internal static class WorkerHandoffValidation
{
    internal static string Id(string value) => Guid.TryParseExact(value, "D", out var id)
        ? id.ToString("D") : throw new WorkerRequestException("A valid handoff attempt ID is required.");

    internal static WorkerHandoffSnapshot Check(WorkerHandoffSnapshot value, string attemptId)
    {
        if (Id(value.AttemptId) != Id(attemptId) || !Guid.TryParseExact(value.HandoffId, "D", out _)
            || !Guid.TryParseExact(value.RecordId, "D", out _) || value.TaskId is not null && !Guid.TryParseExact(value.TaskId, "D", out _)
            || value.ProfileKey is null || value.ProfileKey.Length is < 1 or > 200 || value.ProfileKey.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not ('-' or '_'))
            || value.LeaseOwner is null || value.LeaseOwner.Length is < 1 or > 200 || value.LeaseOwner.Any(char.IsControl) || value.LeaseGeneration < 1
            || value.Reason is not ("login" or "account_creation" or "captcha" or "terms" or "security_warning" or "verification")
            || value.Status is not ("parked" or "opening" or "open" or "resuming" or "resolved" or "cancelled" or "expired")
            || !Uri.TryCreate(value.AllowedOrigin, UriKind.Absolute, out var origin)
            || origin.Scheme is not ("https" or "http") || origin.UserInfo.Length > 0 || origin.AbsolutePath != "/"
            || origin.Query.Length > 0 || origin.Fragment.Length > 0)
            throw new WorkerRequestException("Private API returned an invalid browser handoff scope.", 502);
        return value with { AllowedOrigin = origin.GetLeftPart(UriPartial.Authority), Events = [] };
    }

    internal static void SameScope(WorkerHandoffSnapshot before, WorkerHandoffSnapshot after, bool opening = false)
    {
        if (before.HandoffId != after.HandoffId || before.AttemptId != after.AttemptId || before.RecordId != after.RecordId
            || before.ProfileKey != after.ProfileKey || before.AllowedOrigin != after.AllowedOrigin
            || before.LeaseOwner != after.LeaseOwner || after.LeaseGeneration != before.LeaseGeneration + (opening ? 1 : 0))
            throw new WorkerRequestException("Browser handoff ownership or scope changed; reopen from the dashboard.", 409);
    }
}
