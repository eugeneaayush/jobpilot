using System.Text.Json;
using System.Text.Json.Nodes;
using JobPilot.Terminal.Workers;
using Xunit;
using System.Diagnostics;
using static JobPilot.Terminal.Tests.WorkerFixtures;

namespace JobPilot.Terminal.Tests;

public sealed class CodexSupervisorTests
{
    [Fact]
    public void IsolationDisablesEveryConfiguredMcpWithoutOverridingProvider()
    {
        var effective = JsonNode.Parse("""
            {"model":"saved-model","model_provider":"saved-provider","mcp_servers":{
            "one":{"command":"never-run","enabled":true,"env":{"SECRET":"synthetic"}},
            "name.with.dots":{"url":"https://invalid.example","enabled":true}}}
            """)!.AsObject();
        var config = CodexSupervisorPolicy.Configuration(effective);
        Assert.False(config.ContainsKey("model"));
        Assert.False(config.ContainsKey("model_provider"));
        Assert.All(config["mcp_servers"]!.AsObject(), entry => Assert.False(entry.Value!["enabled"]!.GetValue<bool>()));
        Assert.True(effective["mcp_servers"]!["one"]!["enabled"]!.GetValue<bool>());
        Assert.All(CodexSupervisorPolicy.DisabledFeatures, feature => Assert.False(config["features"]![feature]!.GetValue<bool>()));
        Assert.Empty(config["notify"]!.AsArray());
        Assert.Equal("disabled", config["web_search"]!.GetValue<string>());
    }

    [Fact]
    public void NewAndResumedTurnsHaveNoEnvironmentAndOnlyPublicMetadata()
    {
        var input = JsonDocument.Parse("""
            {"campaignId":"campaign","mode":"submit","task":"must not reach model","applicant":{"email":"private-canary"},
             "record":{"id":"job","title":"public job","resume":"private-canary"},
             "lease":{"id":"attempt","state":"prepared","token":"private-canary"}}
            """).RootElement.Clone();
        var request = Request(role: "supervisor") with { Input = input };
        var context = new AgentRunContext(request, "/private/task", Guid.NewGuid().ToString("D"), 1, null, (_, _) => Task.CompletedTask);
        var start = CodexSupervisorPolicy.ThreadParameters(context, new());
        Assert.Empty(start["environments"]!.AsArray());
        Assert.Empty(start["dynamicTools"]!.AsArray());
        Assert.Empty(start["selectedCapabilityRoots"]!.AsArray());
        Assert.False(start.ContainsKey("model"));
        var session = Guid.NewGuid().ToString("D");
        var resume = CodexSupervisorPolicy.ThreadParameters(context with { ResumeSessionId = session }, new());
        Assert.Equal(session, resume["threadId"]!.GetValue<string>());
        var turn = CodexSupervisorPolicy.TurnParameters(session, request);
        Assert.Empty(turn["environments"]!.AsArray());
        Assert.DoesNotContain("private-canary", turn.ToJsonString());
        Assert.DoesNotContain("must not reach model", turn.ToJsonString());
        Assert.Contains("public job", turn.ToJsonString());
    }

    [Theory]
    [InlineData("codex-cli 0.154.0-alpha.6.2", true)]
    [InlineData("codex-cli 0.155.0-alpha.2.6", true)]
    [InlineData("codex-cli 0.155.0-alpha.9.2", true)]
    [InlineData("codex-cli 0.155.0-alpha.16", true)]
    [InlineData("codex-cli 0.155.0-alpha.16.3", true)]
    [InlineData("codex-cli 0.155.0-alpha.16.30", false)]
    [InlineData("codex-cli 0.155.0-alpha.16.3-unverified", false)]
    [InlineData("codex-cli 0.155.0-alpha.16.3+unverified", false)]
    [InlineData("unverified-cli 0.155.0-alpha.16.3", false)]
    [InlineData("codex-cli 0.155.0-alpha.160", false)]
    [InlineData("codex-cli 0.155.0-alpha.16-unverified", false)]
    [InlineData("codex-cli 0.155.0-alpha.16+unverified", false)]
    [InlineData("unverified-cli 0.155.0-alpha.16", false)]
    [InlineData("codex-cli 0.155.0-alpha.9.20", false)]
    [InlineData("codex-cli 0.155.0-alpha.9.2-unverified", false)]
    [InlineData("codex-cli 0.155.0-alpha.2.60", false)]
    [InlineData("codex-cli 0.155.0-alpha.2.6-unverified", false)]
    [InlineData("unverified-cli 0.155.0-alpha.2.6", false)]
    [InlineData("codex-cli 0.153.0", false)]
    [InlineData(null, false)]
    public void CapabilitiesRequireVerifiedInterfaceVersion(string? version, bool expected) =>
        Assert.Equal(expected, CodexSupervisorPolicy.SupportsVersion(version));

    [Theory]
    [InlineData("Codex Desktop/0.155.0-alpha.2.6 (Mac OS 27.2.0; arm64) dumb (jobpilot_supervisor; 1.0)", true)]
    [InlineData("codex-cli/0.154.0-alpha.6.2", true)]
    [InlineData("codex-cli/0.155.0-alpha.2.6", true)]
    [InlineData("Codex Desktop/0.155.0-alpha.9.2 (Mac OS 27.2.0; arm64) dumb (jobpilot_supervisor; 1.0)", true)]
    [InlineData("codex-cli/0.155.0-alpha.9.2", true)]
    [InlineData("Codex Desktop/0.155.0-alpha.16 (Mac OS 27.2.0; arm64) dumb (jobpilot_supervisor; 1.0)", true)]
    [InlineData("codex-cli/0.155.0-alpha.16", true)]
    [InlineData("Codex Desktop/0.155.0-alpha.16.3 (Mac OS 27.2.0; arm64) dumb (jobpilot_supervisor; 1.0)", true)]
    [InlineData("codex-cli/0.155.0-alpha.16.3", true)]
    [InlineData("Codex Desktop/0.155.0-alpha.16.30", false)]
    [InlineData("Codex Desktop/0.155.0-alpha.16.3-unverified", false)]
    [InlineData("Codex Desktop/0.155.0-alpha.16.3+unverified", false)]
    [InlineData("Codex Desktop/0.999.0 (0.155.0-alpha.16.3)", false)]
    [InlineData("unverified/0.155.0-alpha.16.3", false)]
    [InlineData("Codex Desktop/0.155.0-alpha.160", false)]
    [InlineData("Codex Desktop/0.155.0-alpha.16-unverified", false)]
    [InlineData("Codex Desktop/0.155.0-alpha.16+unverified", false)]
    [InlineData("Codex Desktop/0.999.0 (0.155.0-alpha.16)", false)]
    [InlineData("unverified/0.155.0-alpha.16", false)]
    [InlineData("Codex Desktop/0.155.0-alpha.9.20", false)]
    [InlineData("Codex Desktop/0.155.0-alpha.9.2-unverified", false)]
    [InlineData("Codex Desktop/0.155.0-alpha.2.60", false)]
    [InlineData("Codex Desktop/0.155.0-alpha.2.6-unverified", false)]
    [InlineData("Codex Desktop/0.999.0 (0.155.0-alpha.2.6)", false)]
    [InlineData("unverified/0.155.0-alpha.2.6", false)]
    [InlineData(null, false)]
    public void InitializationRequiresVerifiedProductVersion(string? userAgent, bool expected) =>
        Assert.Equal(expected, CodexSupervisorPolicy.SupportsUserAgent(userAgent));

    [Fact]
    public void ClaudePromptContainsOnlyOpaqueScopeIdentifiers()
    {
        using var json = JsonDocument.Parse("""
            {"attemptId":"attempt","leaseOwner":"owner","leaseGeneration":2,
             "task":"private-canary","answers":{"email":"private-canary"},"resume":"private-canary"}
            """);
        var input = ProcessAgentAdapter.WorkerInput(json.RootElement);
        Assert.Equal(3, input.EnumerateObject().Count());
        Assert.DoesNotContain("private-canary", input.GetRawText());
    }

    [Fact]
    public void ClaudeBareSettingsPreserveProviderButOmitPersonalCustomization()
    {
        var saved = JsonNode.Parse("""
            {"model":"saved-model","apiKeyHelper":"saved-helper","hooks":{"start":"never-run"},
             "enabledPlugins":{"private":true},"systemPrompt":"private-canary",
             "env":{"ANTHROPIC_BASE_URL":"https://provider.invalid","ANTHROPIC_AUTH_TOKEN":"synthetic-auth",
                    "ANTHROPIC_MODEL":"saved-model","JOBPILOT_API_TOKEN":"private-canary"}}
            """)!.AsObject();
        var selected = ClaudeWorkerAdapter.ProviderSettings(saved);
        Assert.Equal("saved-model", selected["model"]!.GetValue<string>());
        Assert.Equal("saved-helper", selected["apiKeyHelper"]!.GetValue<string>());
        Assert.Equal("synthetic-auth", selected["env"]!["ANTHROPIC_AUTH_TOKEN"]!.GetValue<string>());
        Assert.DoesNotContain("private-canary", selected.ToJsonString());
        Assert.False(selected.ContainsKey("hooks"));
        Assert.False(selected.ContainsKey("enabledPlugins"));
    }

    [Fact]
    public void SandboxRejectsPublicDirectoryOutsideItsPrivateRoot()
    {
        if (!CodexSupervisorPolicy.PlatformSupported) return;
        using var temp = new TempDir();
        var root = Path.Combine(temp.Root, "private");
        var sibling = Path.Combine(temp.Root, "private-sibling");
        Directory.CreateDirectory(root);
        Directory.CreateDirectory(sibling);
        foreach (var invalid in new[] { root, temp.Root, sibling })
            Assert.Throws<IOException>(() => CodexSupervisorPolicy.SandboxProfile(root, temp.Root, invalid));
        var alias = Path.Combine(root, "root-alias");
        Directory.CreateSymbolicLink(alias, root);
        Assert.Throws<IOException>(() => CodexSupervisorPolicy.SandboxProfile(root, temp.Root, alias));
    }

    [Fact]
    public async Task MacSandboxDeniesPrivateCanaryThroughTemporaryDirectoryAliases()
    {
        if (!CodexSupervisorPolicy.PlatformSupported) return;
        using var temp = new TempDir();
        var secret = Path.Combine(temp.Root, "private-canary.txt");
        File.WriteAllText(secret, "synthetic-private-canary");
        var home = Path.Combine(temp.Root, "codex-home");
        Directory.CreateDirectory(home);
        var publicDirectory = Path.Combine(temp.Root, "public-task");
        Directory.CreateDirectory(publicDirectory);
        var publicFile = Path.Combine(publicDirectory, "public.txt");
        File.WriteAllText(publicFile, "public-input");
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo("/usr/bin/sandbox-exec")
            {
                UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true,
                ArgumentList = { "-p", CodexSupervisorPolicy.SandboxProfile(temp.Root, home, publicDirectory), "/bin/cat", secret },
            },
        };
        process.Start();
        var output = await process.StandardOutput.ReadToEndAsync();
        await process.WaitForExitAsync();
        Assert.NotEqual(0, process.ExitCode);
        Assert.DoesNotContain("synthetic-private-canary", output);
        process.StartInfo.ArgumentList[^1] = publicFile;
        process.Start();
        var publicOutput = await process.StandardOutput.ReadToEndAsync();
        await process.WaitForExitAsync();
        Assert.Equal(0, process.ExitCode);
        Assert.Equal("public-input", publicOutput);
    }

    [Theory]
    [InlineData("{\"allowApplicantData\":true}", false)]
    [InlineData("{\"verified\":true,\"allowApplicantData\":true,\"model\":\"saved-model\"}", true)]
    [InlineData("{\"verified\":true,\"allowMetadataOnly\":true,\"model\":\"saved-model\"}", true)]
    [InlineData("{\"allowMetadataOnly\":true,\"model\":\"saved-model\"}", false)]
    [InlineData("{\"verified\":true,\"allowMetadataOnly\":true}", false)]
    public void MetadataOnlyScopeRequiresVerificationAndModel(string json, bool expected)
    {
        using var value = JsonDocument.Parse(json);
        Assert.Equal(expected, ConfiguredWorkerBroker.ApprovedScope(value.RootElement));
    }
}
