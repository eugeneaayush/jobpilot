using System.Text.Json;
using System.Text.Json.Nodes;
using System.Security.Cryptography;
using JobPilot.Terminal.Common;

namespace JobPilot.Terminal.Workers;

public sealed record WorkerBrokerGrant(string McpConfigPath, string[] AllowedTools, bool CanSubmit, string[] Secrets, WorkerBrowserScope? BrowserScope = null);
public sealed record WorkerProviderScope(bool Approved, string? Scope, string? BlockReason);

public interface IWorkerBroker
{
    Task<WorkerBrokerGrant?> AuthorizeAsync(AgentTaskRequest task, WorkerIdentity identity, string workingDirectory, CancellationToken ct);
}

public sealed class ConfiguredWorkerBroker(WorkerOptions options) : IWorkerBroker
{
    public WorkerProviderScope ProviderScope()
    {
        try
        {
            using var runtime = JsonDocument.Parse(File.ReadAllText(Path.Combine(options.PersonalRoot, "runtime.json")));
            var approval = runtime.RootElement.GetProperty("providerApproval");
            if (!ApprovedScope(approval) || !approval.TryGetProperty("provider", out var provider)
                || provider.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(provider.GetString()))
                return new(false, null, "The configured Claude provider has no verified data scope.");
            var template = JsonNode.Parse(File.ReadAllText(options.McpConfigPath!));
            var server = template?["mcpServers"]?["jobpilot"];
            var script = server?["args"]?[0]?.GetValue<string>();
            var command = server?["command"]?.GetValue<string>();
            if (script is null || !Path.IsPathFullyQualified(script) || Path.GetFileName(script) != "personal-browser.ts"
                || server?["args"] is not JsonArray args || args.Count != 1 || command is null
                || Path.GetFileName(command) is not ("bun" or "bun.exe") || ExecutablePath.Find(command) is null)
                return new(false, null, "Scoped broker configuration is unavailable.");
            VerifyReceipt(approval, script, options.ClaudeSettingsPath);
            return new(true, approval.TryGetProperty("allowApplicantData", out var data) && data.ValueKind == JsonValueKind.True ? "applicant_data" : "metadata_only", null);
        }
        catch (Exception ex) when (ex is IOException or JsonException or InvalidOperationException or ArgumentException or KeyNotFoundException or WorkerRequestException)
        {
            return new(false, null, "Provider settings or scoped broker need a current verified data-boundary receipt.");
        }
    }

    internal static readonly string[] Tools =
    [
        "mcp__jobpilot__inspect_form", "mcp__jobpilot__fill_field", "mcp__jobpilot__upload_resume",
        "mcp__jobpilot__upload_attachment",
        "mcp__jobpilot__submit_application", "mcp__jobpilot__reconcile",
    ];

    public Task<WorkerBrokerGrant?> AuthorizeAsync(AgentTaskRequest task, WorkerIdentity identity, string workingDirectory, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(options.McpConfigPath) || !File.Exists(options.McpConfigPath))
            return Task.FromResult<WorkerBrokerGrant?>(null);

        var approvalPath = Path.Combine(Path.GetFullPath(options.PersonalRoot), "runtime.json");
        if (!File.Exists(approvalPath)) throw new WorkerRequestException("The configured Claude provider has no verified data scope.", 409);
        JsonElement approvalReceipt;
        using (var runtime = JsonDocument.Parse(File.ReadAllText(approvalPath)))
        {
            if (!runtime.RootElement.TryGetProperty("providerApproval", out var approval)
                || approval.ValueKind != JsonValueKind.Object
                || !approval.TryGetProperty("provider", out var provider) || provider.ValueKind != JsonValueKind.String
                || string.IsNullOrWhiteSpace(provider.GetString())
                || !ApprovedScope(approval))
                throw new WorkerRequestException("The configured Claude provider has no verified data scope.", 409);
            approvalReceipt = approval.Clone();
        }

        var input = task.Input;
        if (!input.TryGetProperty("attemptId", out var attempt) || attempt.ValueKind != JsonValueKind.String
            || string.IsNullOrWhiteSpace(attempt.GetString())
            || !input.TryGetProperty("leaseOwner", out var owner) || owner.ValueKind != JsonValueKind.String
            || string.IsNullOrWhiteSpace(owner.GetString())
            || !input.TryGetProperty("leaseGeneration", out var generation) || !generation.TryGetInt64(out var gen) || gen < 1)
            throw new WorkerRequestException("Real workers require attemptId, leaseOwner and positive leaseGeneration from an API lease.");

        var template = JsonNode.Parse(File.ReadAllText(options.McpConfigPath));
        var configured = template?["mcpServers"]?["jobpilot"] as JsonObject;
        var command = configured?["command"]?.GetValue<string>();
        var args = configured?["args"] as JsonArray;
        if (configured is null || command is null || Path.GetFileName(command) is not ("bun" or "bun.exe")
            || args is null || args.Count != 1 || args[0]?.GetValue<string>() is not { } script
            || !Path.IsPathFullyQualified(script) || Path.GetFileName(script) != "personal-browser.ts" || !File.Exists(script))
            throw new WorkerRequestException("The configured broker must run bun with one absolute personal-browser.ts script path.", 503);

        VerifyReceipt(approvalReceipt, script, options.ClaudeSettingsPath);

        // Template transport/header keys cannot redirect the scoped broker away from local stdio.
        var server = new JsonObject
        {
            ["type"] = "stdio",
            ["command"] = ExecutablePath.Find(command)
                ?? throw new WorkerRequestException("The configured broker's Bun executable is unavailable.", 503),
            ["args"] = new JsonArray(script),
        };
        server["env"] = new JsonObject
        {
            ["JOBPILOT_API"] = options.PrivateApiOrigin().ToString().TrimEnd('/'),
            ["JOBPILOT_API_TOKEN"] = identity.Bearer,
            ["JOBPILOT_ATTEMPT_ID"] = attempt.GetString(),
            ["JOBPILOT_LEASE_OWNER"] = owner.GetString(),
            ["JOBPILOT_LEASE_GENERATION"] = gen.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["JOBPILOT_PERSONAL_ROOT"] = Path.GetFullPath(options.PersonalRoot),
        };
        var config = new JsonObject { ["mcpServers"] = new JsonObject { ["jobpilot"] = server } };
        var path = Path.Combine(workingDirectory, "broker.json");
        PrivateTaskStore.WritePrivate(path, config.ToJsonString());
        var canSubmit = task.Kind == "apply";
        var allowed = Tools.Where(tool => canSubmit || tool != "mcp__jobpilot__submit_application").ToArray();
        var scope = new WorkerBrowserScope(Path.GetFullPath(options.PersonalRoot), identity.UserId, task.TaskId,
            attempt.GetString()!, owner.GetString()!, gen, options.PrivateApiOrigin(), identity.Bearer, DateTimeOffset.UtcNow);
        return Task.FromResult<WorkerBrokerGrant?>(new(path, allowed, canSubmit, [identity.Bearer], scope));
    }

    internal static bool ApprovedScope(JsonElement approval) =>
        approval.TryGetProperty("verified", out var verified) && verified.ValueKind == JsonValueKind.True
        && (approval.TryGetProperty("allowApplicantData", out var applicant) && applicant.ValueKind == JsonValueKind.True
            || approval.TryGetProperty("allowMetadataOnly", out var metadata) && metadata.ValueKind == JsonValueKind.True)
        && approval.TryGetProperty("model", out var model) && model.ValueKind == JsonValueKind.String
        && !string.IsNullOrWhiteSpace(model.GetString());

    internal static string BrokerHash(string script)
    {
        var directory = Path.GetDirectoryName(script)!;
        var modules = Directory.GetFiles(Path.Combine(directory, "personal-browser"), "*.ts", SearchOption.AllDirectories)
            .Select(path => (Path: path, Relative: Path.GetRelativePath(directory, path).Replace(Path.DirectorySeparatorChar, '/')))
            .OrderBy(file => file.Relative, StringComparer.Ordinal);
        var lines = new[] { "personal-browser.ts:" + FileHash(script) }
            .Concat(modules.Select(file => file.Relative + ":" + FileHash(file.Path)));
        return PrivateTaskStore.Hash(string.Join('\n', lines));
    }

    private static string FileHash(string path) => Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(path)));

    internal static void VerifyReceipt(JsonElement approval, string script, string settings)
    {
        if (!approval.TryGetProperty("verification", out var receipt) || receipt.ValueKind != JsonValueKind.Object
            || !receipt.TryGetProperty("providerConfigPath", out var path) || path.ValueKind != JsonValueKind.String
            || Path.GetFullPath(path.GetString()!) != Path.GetFullPath(settings)
            || !receipt.TryGetProperty("providerConfigSha256", out var configHash) || configHash.ValueKind != JsonValueKind.String
            || !receipt.TryGetProperty("brokerSha256", out var brokerHash) || brokerHash.ValueKind != JsonValueKind.String
            || !File.Exists(settings) || configHash.GetString() != FileHash(settings) || brokerHash.GetString() != BrokerHash(script))
            throw new WorkerRequestException("Provider settings or scoped broker changed; verify the data boundary again.", 409);
    }
}
