using System.Text.Json;
using JobPilot.Terminal.Workers;

namespace JobPilot.Terminal.Tests;

internal sealed class FakeWorkerBroker(bool available = false, bool canSubmit = false) : IWorkerBroker
{
    public Task<WorkerBrokerGrant?> AuthorizeAsync(AgentTaskRequest task, WorkerIdentity identity, string workingDirectory, CancellationToken ct)
    {
        WorkerBrokerGrant? result = available ? new(Path.Combine(workingDirectory, "broker.json"), [], canSubmit, [identity.Bearer]) : null;
        return Task.FromResult(result);
    }
}

internal sealed class FakeWorkerAttemptApi : IWorkerAttemptApi
{
    public bool Renew { get; set; } = true;
    public bool Receipt { get; set; }
    public int Renewals { get; private set; }
    public int Cancellations { get; private set; }
    public Task<bool> RenewAsync(WorkerIdentity identity, AgentTaskRequest task, CancellationToken ct)
    {
        Renewals++;
        return Task.FromResult(Renew);
    }
    public Task<bool> HasSubmissionReceiptAsync(WorkerIdentity identity, AgentTaskRequest task, CancellationToken ct) => Task.FromResult(Receipt);
    public Task<bool> CancelAsync(WorkerIdentity identity, AgentTaskRequest task, CancellationToken ct)
    {
        Cancellations++;
        return Task.FromResult(true);
    }
}

internal static class WorkerFixtures
{
    public static readonly WorkerIdentity Identity = new("test-user", "never-log-this-token");
    public static AgentTaskRequest Request(string scenario = "success", string role = "worker", string adapter = "mock", string? kind = null) => new()
    {
        TaskId = Guid.NewGuid().ToString("D"), Role = role, Adapter = adapter,
        Kind = kind ?? (role == "supervisor" ? "plan" : "prepare_apply"),
        Input = JsonDocument.Parse("{\"mockScenario\":\"" + scenario + "\"}").RootElement.Clone(),
    };
    public static WorkerTaskService Service(WorkerOptions options, IWorkerBroker? broker = null, IWorkerAttemptApi? api = null, IAgentAdapter? adapter = null) =>
        new(options, new PrivateTaskStore(options), broker ?? new FakeWorkerBroker(), api ?? new FakeWorkerAttemptApi(),
            new Dictionary<string, IAgentAdapter> { ["mock"] = adapter ?? new MockAgentAdapter(), ["claude"] = adapter ?? new MockAgentAdapter(), ["codex"] = adapter ?? new MockAgentAdapter() });
    public static async Task<AgentTaskSnapshot> Finished(WorkerTaskService service, string id)
    {
        for (var attempt = 0; attempt < 500; attempt++)
        {
            var state = service.Get(Identity.UserId, id)!;
            if (state.Phase == "finished") return state;
            await Task.Delay(10);
        }
        throw new TimeoutException("Mock task did not finish.");
    }
}
