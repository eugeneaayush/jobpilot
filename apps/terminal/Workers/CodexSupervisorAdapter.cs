using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using JobPilot.Terminal.Common;

namespace JobPilot.Terminal.Workers;

public sealed class CodexSupervisorAdapter(WorkerOptions options) : IAgentAdapter
{
    public async Task<AgentRunResult> RunAsync(AgentRunContext context, CancellationToken cancellationToken)
    {
        var executable = ExecutablePath.Find("codex");
        if (executable is null) return new("blocked", Error: "Codex is not installed or is not on PATH.");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(options.Timeout);
        var ct = deadline.Token;
        var stage = "startup";
        try
        {
            await using var rpc = await CodexSupervisorRpc.StartAsync(executable, context.WorkingDirectory, options, ct);
            stage = "initialize";
            var initialized = await rpc.RequestAsync("initialize", new JsonObject
            {
                ["clientInfo"] = new JsonObject { ["name"] = "jobpilot_supervisor", ["version"] = "1.0" },
                ["capabilities"] = new JsonObject { ["experimentalApi"] = true },
            }, ct);
            if (!CodexSupervisorPolicy.SupportsUserAgent(initialized["userAgent"]?.GetValue<string>()))
                return new("blocked", Error: CodexSupervisorPolicy.Unavailable);
            await rpc.NotifyAsync("initialized", ct);
            stage = "configuration";
            // Effective configuration is retained only in memory; it may contain provider secrets.
            var read = await rpc.RequestAsync("config/read", new JsonObject { ["cwd"] = context.WorkingDirectory, ["includeLayers"] = false }, ct);
            var config = read["config"] as JsonObject ?? throw new InvalidDataException("Missing effective configuration.");
            stage = "session";
            var started = await rpc.RequestAsync(context.ResumeSessionId is null ? "thread/start" : "thread/resume",
                CodexSupervisorPolicy.ThreadParameters(context, config), ct);
            if (started["instructionSources"] is JsonArray sources && sources.Count > 0)
                throw new InvalidDataException("Unexpected automatic instruction source.");
            var id = started["thread"]?["id"]?.GetValue<string>();
            if (!Guid.TryParse(id, out _)) throw new InvalidDataException("Invalid supervisor session.");
            await context.EmitAsync("session", id!);
            stage = "turn";
            await rpc.RequestAsync("turn/start", CodexSupervisorPolicy.TurnParameters(id!, context.Request), ct);
            var output = new AgentOutput();
            while (true)
            {
                var message = await rpc.NextNotificationAsync(ct);
                if (message["params"] is not JsonObject data || data["threadId"]?.GetValue<string>() != id) continue;
                var method = message["method"]?.GetValue<string>();
                if (method == "item/completed" && data["item"] is JsonObject item)
                {
                    var type = item["type"]?.GetValue<string>();
                    if (type is not ("agentMessage" or "reasoning" or "userMessage" or "plan"))
                        throw new InvalidDataException("Supervisor attempted a tool action.");
                    if (type == "agentMessage" && item["text"]?.GetValue<string>() is { } text)
                        output.Feed(new JsonObject { ["type"] = "result", ["result"] = text }.ToJsonString());
                }
                if (method != "turn/completed") continue;
                if (data["turn"]?["status"]?.GetValue<string>() != "completed")
                    return new("failed", Error: "Codex supervisor turn did not complete.", Retryable: true);
                if (output.Result is not { } result) return new("failed", Error: "Codex supervisor returned no valid structured proposal.");
                var fields = result.GetProperty("data");
                if (fields.GetProperty("mock").GetBoolean() || fields.GetProperty("receipt").ValueKind != JsonValueKind.Null
                    || fields.GetProperty("taskKind").GetString() != "plan")
                    return new("failed", Error: "Codex supervisor proposal exceeded its role.");
                PrivateTaskStore.WritePrivate(Path.Combine(context.WorkingDirectory, "stdout.jsonl"), result.GetRawText() + "\n");
                return new(result.GetProperty("outcome").GetString()!, result);
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            return new("cancelled", Error: "Codex supervisor execution was cancelled.");
        }
        catch (WorkerRequestException ex) { return new("blocked", Error: ex.Message); }
        catch (Exception ex) when (ex is IOException or JsonException or InvalidDataException or System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            return new("blocked", Error: $"Codex supervisor isolation or protocol check failed during {stage}; no proposal was accepted.");
        }
    }
}
