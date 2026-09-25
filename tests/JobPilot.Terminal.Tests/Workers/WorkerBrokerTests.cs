using System.Text.Json;
using System.Text.Json.Nodes;
using System.Security.Cryptography;
using JobPilot.Terminal.Workers;
using Xunit;
using static JobPilot.Terminal.Tests.WorkerFixtures;

namespace JobPilot.Terminal.Tests;

public sealed class WorkerBrokerTests
{
    [Fact]
    public async Task RealWorkerRequiresExplicitPrivateProviderApproval()
    {
        using var temp = new TempDir();
        var template = Path.Combine(temp.Root, "template.json");
        File.WriteAllText(template, "{}");
        var broker = new ConfiguredWorkerBroker(new() { PersonalRoot = temp.Root, McpConfigPath = template });
        var error = await Assert.ThrowsAsync<WorkerRequestException>(() => broker.AuthorizeAsync(Request(adapter: "claude"), Identity, temp.Root, CancellationToken.None));
        Assert.Contains("verified data scope", error.Message);
        File.WriteAllText(Path.Combine(temp.Root, "runtime.json"), "{\"providerApproval\":{\"allowApplicantData\":true}}");
        await Assert.ThrowsAsync<WorkerRequestException>(() => broker.AuthorizeAsync(Request(adapter: "claude"), Identity, temp.Root, CancellationToken.None));
    }

    [Fact]
    public async Task BrokerTemplateProducesOnlyScopedPrivateMcpConfiguration()
    {
        if (JobPilot.Terminal.Common.ExecutablePath.Find("bun") is null) return;
        using var temp = new TempDir();
        var script = Path.Combine(temp.Root, "personal-browser.ts");
        File.WriteAllText(script, "// Synthetic broker fixture; never executed.");
        Directory.CreateDirectory(Path.Combine(temp.Root, "personal-browser"));
        File.WriteAllText(Path.Combine(temp.Root, "personal-browser", "core.ts"), "// Synthetic boundary fixture.");
        var settings = Path.Combine(temp.Root, "settings.json");
        File.WriteAllText(settings, "{}");
        var template = new JsonObject
        {
            ["mcpServers"] = new JsonObject
            {
                ["jobpilot"] = new JsonObject
                {
                    ["command"] = "bun", ["args"] = new JsonArray(script),
                    ["type"] = "http", ["url"] = "https://synthetic-transport.example.test/mcp",
                    ["headers"] = new JsonObject { ["authorization"] = "synthetic-untrusted-header" },
                    ["env"] = new JsonObject { ["UNTRUSTED_TEMPLATE_ENV"] = "must-not-forward" },
                },
                ["other"] = new JsonObject { ["command"] = "must-not-run" },
            },
        };
        var templatePath = Path.Combine(temp.Root, "template.json");
        File.WriteAllText(templatePath, template.ToJsonString());
        File.WriteAllText(Path.Combine(temp.Root, "runtime.json"), new JsonObject
        {
            ["providerApproval"] = new JsonObject
            {
                ["verified"] = true, ["allowMetadataOnly"] = true, ["allowApplicantData"] = false,
                ["provider"] = "synthetic-test-provider", ["model"] = "synthetic-model",
                ["verification"] = new JsonObject
                {
                    ["providerConfigPath"] = settings,
                    ["providerConfigSha256"] = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(settings))),
                    ["brokerSha256"] = ConfiguredWorkerBroker.BrokerHash(script),
                },
            },
        }.ToJsonString());
        var task = Request(adapter: "claude") with
        {
            Input = JsonDocument.Parse("{\"attemptId\":\"test-attempt\",\"leaseOwner\":\"test-owner\",\"leaseGeneration\":1}").RootElement.Clone(),
        };
        var broker = new ConfiguredWorkerBroker(new() { PersonalRoot = temp.Root, McpConfigPath = templatePath, ClaudeSettingsPath = settings });
        Assert.Equal("metadata_only", broker.ProviderScope().Scope);
        var grant = await broker.AuthorizeAsync(task, Identity, temp.Root, CancellationToken.None);
        Assert.NotNull(grant);
        Assert.NotNull(grant.BrowserScope);
        Assert.Equal(Identity.UserId, grant.BrowserScope.UserId);
        Assert.Equal(Identity.Bearer, grant.BrowserScope.Bearer);
        Assert.Equal(task.TaskId, grant.BrowserScope.TaskId);
        Assert.Equal("test-attempt", grant.BrowserScope.AttemptId);
        Assert.Equal("test-owner", grant.BrowserScope.LeaseOwner);
        Assert.Equal(1, grant.BrowserScope.LeaseGeneration);
        Assert.Contains("mcp__jobpilot__upload_attachment", grant.AllowedTools);
        Assert.DoesNotContain("mcp__jobpilot__submit_application", grant.AllowedTools);
        using var config = JsonDocument.Parse(File.ReadAllText(grant.McpConfigPath));
        var servers = config.RootElement.GetProperty("mcpServers");
        Assert.Single(servers.EnumerateObject());
        var scoped = servers.GetProperty("jobpilot");
        Assert.Equal("stdio", scoped.GetProperty("type").GetString());
        Assert.Equal(4, scoped.EnumerateObject().Count());
        Assert.False(scoped.TryGetProperty("url", out _));
        Assert.False(scoped.TryGetProperty("headers", out _));
        Assert.False(scoped.GetProperty("env").TryGetProperty("UNTRUSTED_TEMPLATE_ENV", out _));
        Assert.Equal(Identity.Bearer, servers.GetProperty("jobpilot").GetProperty("env").GetProperty("JOBPILOT_API_TOKEN").GetString());
        if (!OperatingSystem.IsWindows()) Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(grant.McpConfigPath));
        File.AppendAllText(settings, " ");
        Assert.False(broker.ProviderScope().Approved);
        await Assert.ThrowsAsync<WorkerRequestException>(() => broker.AuthorizeAsync(task, Identity, temp.Root, CancellationToken.None));
        File.WriteAllText(settings, "{}");
        File.AppendAllText(Path.Combine(temp.Root, "personal-browser", "core.ts"), "\n// drift");
        Assert.False(broker.ProviderScope().Approved);
    }

    [Fact]
    public void BrokerBoundaryHashIncludesNewImportedModulesInStableRelativeOrder()
    {
        using var temp = new TempDir();
        var script = Path.Combine(temp.Root, "personal-browser.ts");
        File.WriteAllText(script, "entry");
        var directory = Path.Combine(temp.Root, "personal-browser");
        Directory.CreateDirectory(directory);
        File.WriteAllText(Path.Combine(directory, "core.ts"), "core");
        var before = ConfiguredWorkerBroker.BrokerHash(script);
        File.WriteAllText(Path.Combine(directory, "handoff.ts"), "handoff");
        File.WriteAllText(Path.Combine(directory, "attachments.ts"), "attachments");
        var lines = "personal-browser.ts:" + PrivateTaskStore.Hash("entry")
            + "\npersonal-browser/attachments.ts:" + PrivateTaskStore.Hash("attachments")
            + "\npersonal-browser/core.ts:" + PrivateTaskStore.Hash("core")
            + "\npersonal-browser/handoff.ts:" + PrivateTaskStore.Hash("handoff");
        Assert.Equal(PrivateTaskStore.Hash(lines), ConfiguredWorkerBroker.BrokerHash(script));
        Assert.NotEqual(before, ConfiguredWorkerBroker.BrokerHash(script));
        File.AppendAllText(Path.Combine(directory, "handoff.ts"), " drift");
        Assert.NotEqual(PrivateTaskStore.Hash(lines), ConfiguredWorkerBroker.BrokerHash(script));
    }
}
