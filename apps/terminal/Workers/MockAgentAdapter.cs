using System.Text.Json;
using System.Text.Json.Nodes;

namespace JobPilot.Terminal.Workers;

public sealed class MockAgentAdapter : IAgentAdapter
{
    public async Task<AgentRunResult> RunAsync(AgentRunContext context, CancellationToken cancellationToken)
    {
        var input = context.Request.Input;
        var scenario = input.TryGetProperty("mockScenario", out var supplied) && supplied.ValueKind == JsonValueKind.String ? supplied.GetString() : "success";
        await context.EmitAsync("progress", "Mock task is processing its bounded input.");
        if (scenario == "wait") await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
        await Task.Delay(25, cancellationToken);
        if (scenario == "retry" && context.Attempt == 1) return new("failed", Error: "Simulated pre-submission transport failure.", Retryable: true);
        if (scenario == "fail") return new("failed", Error: "Simulated execution failure.");
        var outcome = scenario == "needs_user" ? "needs_user" : "completed";
        var next = context.Request.Role == "supervisor" ? "dispatch_worker" : "none";
        var payload = new JsonObject
        {
            ["outcome"] = outcome, ["summary"] = "Mock completed; no external application was performed.",
            ["nextAction"] = next,
            ["data"] = new JsonObject { ["mock"] = true, ["receipt"] = "mock-" + context.Request.TaskId, ["attemptId"] = null, ["taskKind"] = context.Request.Kind },
        };
        using var result = JsonDocument.Parse(payload.ToJsonString());
        PrivateTaskStore.WritePrivate(Path.Combine(context.WorkingDirectory, "stdout.jsonl"), result.RootElement.GetRawText() + "\n");
        return new(outcome, result.RootElement.Clone());
    }
}
