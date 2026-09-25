using System.Text.Json;
using System.Text.Json.Serialization;

namespace JobPilot.Terminal.Workers;

public sealed record AgentTaskRequest
{
    public required string TaskId { get; init; }
    public required string Role { get; init; }
    public required string Adapter { get; init; }
    public required string Kind { get; init; }
    public required JsonElement Input { get; init; }
    public string? InputHash { get; init; }
}

public sealed record AgentTaskEvent(long Sequence, DateTimeOffset At, string Type, string Message);

public sealed record AgentTaskSnapshot
{
    public required string TaskId { get; init; }
    public required string Role { get; init; }
    public required string Adapter { get; init; }
    public required string Kind { get; init; }
    public required string InputHash { get; init; }
    public required string Status { get; init; }
    public string Phase { get; init; } = "queued";
    public int Attempt { get; init; }
    public string? SessionId { get; init; }
    public DateTimeOffset CreatedAt { get; init; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; init; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? HeartbeatAt { get; init; }
    public DateTimeOffset? LeaseExpiresAt { get; init; }
    public bool SubmissionPossible { get; init; }
    public JsonElement? Result { get; init; }
    public string? Error { get; init; }
    public AgentTaskEvent[] Events { get; init; } = [];
}

internal sealed record StoredAgentTask(AgentTaskRequest Request, AgentTaskSnapshot Snapshot);
public sealed record WorkerIdentity(string UserId, string Bearer);
public sealed record WorkerProviderCapability(string Id, bool Installed, string? Version);
public sealed record WorkerCapabilities(bool StructuredTasks, bool Mock, bool BrokerConfigured, int TimeoutSeconds, int HeartbeatSeconds, int LeaseSeconds, int MaxPreSubmissionRetries, WorkerProviderCapability[] Providers, bool CodexSupervisorEnabled, string? CodexSupervisorBlockReason, bool ProviderApproved, string? ProviderApprovalScope, string? ProviderApprovalBlockReason);
public sealed record AgentRunResult(string Status, JsonElement? Result = null, string? Error = null, bool Retryable = false);

public sealed record AgentRunContext(
    AgentTaskRequest Request, string WorkingDirectory, string SessionId, int Attempt,
    WorkerBrokerGrant? Broker, Func<string, string, Task> EmitAsync, string? ResumeSessionId = null, Func<Task>? BeforeInterruptAsync = null);

public interface IAgentAdapter
{
    Task<AgentRunResult> RunAsync(AgentRunContext context, CancellationToken cancellationToken);
}

public sealed class WorkerRequestException(string message, int statusCode = 400) : Exception(message)
{
    public int StatusCode { get; } = statusCode;
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(AgentTaskRequest))]
[JsonSerializable(typeof(AgentTaskSnapshot))]
[JsonSerializable(typeof(AgentTaskSnapshot[]))]
[JsonSerializable(typeof(StoredAgentTask))]
[JsonSerializable(typeof(WorkerCapabilities))]
[JsonSerializable(typeof(WorkerHandoffSnapshot))]
[JsonSerializable(typeof(WorkerHandoffLease))]
[JsonSerializable(typeof(Dictionary<string, string>))]
internal sealed partial class WorkerJsonContext : JsonSerializerContext;
