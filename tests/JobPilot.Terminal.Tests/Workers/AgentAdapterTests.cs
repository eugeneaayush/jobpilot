using System.Text.Json;
using System.Diagnostics;
using JobPilot.Terminal.Workers;
using Xunit;
using static JobPilot.Terminal.Tests.WorkerFixtures;

namespace JobPilot.Terminal.Tests;

public sealed class AgentAdapterTests
{
    private sealed class ShellAdapter(WorkerOptions options, string script) : ProcessAgentAdapter(options)
    {
        protected override string Executable => "/bin/sh";
        // Model the CLI consuming its prompt before emitting output/exiting; otherwise a
        // fast shell can close stdin before the adapter writes and race this protocol test.
        internal override string[] Arguments(AgentRunContext context, string schemaPath) => ["-c", "read line; " + script];
    }

    private sealed class CleanupTrackingAdapter(WorkerOptions options, string script, string directory) : ProcessAgentAdapter(options)
    {
        protected override string Executable => "/bin/sh";
        internal override string[] Arguments(AgentRunContext context, string schemaPath) => ["-c", "read line; echo $$ > cli.pid; " + script];
        public int CleanupCalls { get; private set; }
        public bool? CliAliveAtCleanup { get; private set; }
        public bool CleanupFails { get; init; }
        internal override Task CleanupBrowserAsync(WorkerBrowserScope scope)
        {
            CleanupCalls++;
            var pid = int.Parse(File.ReadAllText(Path.Combine(directory, "cli.pid")));
            try { using var process = Process.GetProcessById(pid); CliAliveAtCleanup = !process.HasExited; }
            catch (ArgumentException) { CliAliveAtCleanup = false; }
            return CleanupFails ? Task.FromException(new IOException("synthetic-cleanup-failure")) : Task.CompletedTask;
        }
    }

    private static AgentRunContext Context(string directory, WorkerBrokerGrant? grant = null) =>
        new(Request(), directory, Guid.NewGuid().ToString("D"), 1, grant, (_, _) => Task.CompletedTask);

    [Fact]
    public void ClaudeHasOnlyScopedMcpToolsAndNoModelOverride()
    {
        var context = Context("/private/task", new("/private/broker.json", ConfiguredWorkerBroker.Tools, false, []));
        var arguments = new ClaudeWorkerAdapter(new()).Arguments(context, "/private/schema.json");
        Assert.Contains("--strict-mcp-config", arguments);
        Assert.Contains("--bare", arguments);
        Assert.Contains("--no-session-persistence", arguments);
        Assert.Contains("--permission-prompts", arguments);
        Assert.Equal("", arguments[Array.IndexOf(arguments, "--tools") + 1]);
        Assert.DoesNotContain("--model", arguments);
        Assert.DoesNotContain("--plugin-dir", arguments);
        Assert.DoesNotContain("Bash", arguments);
        Assert.Throws<WorkerRequestException>(() => new ClaudeWorkerAdapter(new()).Arguments(Context("/tmp/task"), "/tmp/schema.json"));
    }

    [Fact]
    public void AgentEnvironmentExcludesAppSecretsAndScopeButPreservesConfiguredProvider()
    {
        Dictionary<string, string?> environment = new()
        {
            ["DATABASE_URL"] = "synthetic-database", ["JWT_SECRET"] = "synthetic-jwt",
            ["SECRET_MASTER_KEY"] = "synthetic-key", ["PGPASSWORD"] = "synthetic-password",
            ["PGPASSFILE"] = "synthetic-pg-file", ["STORAGE_ROOT"] = "/private/storage",
            ["JOBPILOT_API_TOKEN"] = "synthetic-bearer", ["JOBPILOT_API"] = "http://localhost:4101",
            ["JOBPILOT_PERSONAL_ROOT"] = "/private/runtime", ["JOBPILOT_WORKER_MCP_CONFIG"] = "/private/broker",
            ["JOBPILOT_ATTEMPT_ID"] = "synthetic-attempt", ["JOBPILOT_LEASE_OWNER"] = "synthetic-owner",
            ["JOBPILOT_LEASE_GENERATION"] = "1", ["PERSONAL_TEST_DATABASE_URL"] = "synthetic-test-db",
            ["ANTHROPIC_AUTH_TOKEN"] = "synthetic-provider-auth", ["ANTHROPIC_BASE_URL"] = "https://provider.invalid",
            ["ANTHROPIC_MODEL"] = "configured-model", ["OPENAI_API_KEY"] = "synthetic-openai-key",
            ["CODEX_HOME"] = "/configured/codex", ["PATH"] = "/usr/bin", ["HOME"] = "/configured/home",
        };
        ProcessAgentAdapter.SanitizeEnvironment(environment);
        Assert.Equal(7, environment.Count);
        Assert.Equal("synthetic-provider-auth", environment["ANTHROPIC_AUTH_TOKEN"]);
        Assert.Equal("https://provider.invalid", environment["ANTHROPIC_BASE_URL"]);
        Assert.Equal("configured-model", environment["ANTHROPIC_MODEL"]);
        Assert.Equal("synthetic-openai-key", environment["OPENAI_API_KEY"]);
        Assert.Equal("/configured/codex", environment["CODEX_HOME"]);
        Assert.Equal("/usr/bin", environment["PATH"]);
        Assert.Equal("/configured/home", environment["HOME"]);
    }

    [Fact]
    public void DecoderRequiresStructuredResultAndRecognizesBothProviders()
    {
        const string final = "{\"outcome\":\"completed\",\"summary\":\"Done\",\"nextAction\":\"none\",\"data\":{\"mock\":false,\"attemptId\":null,\"receipt\":null,\"taskKind\":null}}";
        var claude = new AgentOutput();
        claude.Feed("{\"type\":\"result\",\"is_error\":false,\"structured_output\":" + final + "}");
        Assert.NotNull(claude.Result);
        var codex = new AgentOutput();
        codex.Feed("{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":" + JsonSerializer.Serialize(final) + "}}");
        Assert.NotNull(codex.Result);
        var invalid = new AgentOutput();
        invalid.Feed("{\"type\":\"result\",\"structured_output\":{\"outcome\":\"completed\"}}");
        Assert.Null(invalid.Result);
    }

    [Fact]
    public async Task SubprocessParsesFragmentedJsonlAndRedactsPrivateOutput()
    {
        if (OperatingSystem.IsWindows()) return;
        using var temp = new TempDir();
        var adapter = new ShellAdapter(new() { PersonalRoot = temp.Root },
            "printf '%s' '{\"type\":\"result\",'; printf '%s\\n' '\"structured_output\":{\"outcome\":\"completed\",\"summary\":\"secret-token\",\"nextAction\":\"none\",\"data\":{\"mock\":false,\"attemptId\":null,\"receipt\":null,\"taskKind\":null}}}'");
        var result = await adapter.RunAsync(Context(temp.Root, new(Path.Combine(temp.Root, "broker.json"), [], false, ["secret-token"])), CancellationToken.None);
        Assert.Equal("completed", result.Status);
        Assert.DoesNotContain("secret-token", File.ReadAllText(Path.Combine(temp.Root, "stdout.jsonl")));
        Assert.Equal("[REDACTED]", result.Result!.Value.GetProperty("summary").GetString());
    }

    [Fact]
    public async Task SubprocessOutputLimitAndCancellationAreBounded()
    {
        if (OperatingSystem.IsWindows()) return;
        using var temp = new TempDir();
        var options = new WorkerOptions { PersonalRoot = temp.Root, MaxOutputBytes = 64, CancelGrace = TimeSpan.FromMilliseconds(20) };
        var noisy = new ShellAdapter(options, "printf '%0100d' 0");
        Assert.Equal("failed", (await noisy.RunAsync(Context(temp.Root), CancellationToken.None)).Status);
        var second = Path.Combine(temp.Root, "cancel");
        Directory.CreateDirectory(second);
        using var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(100));
        var waiting = new ShellAdapter(options, "sleep 20 & echo $! > child.pid; wait");
        var run = waiting.RunAsync(Context(second), cancellation.Token);
        Assert.Equal("cancelled", (await run.WaitAsync(TimeSpan.FromSeconds(3))).Status);
        var childId = int.Parse(File.ReadAllText(Path.Combine(second, "child.pid")));
        try
        {
            using var child = Process.GetProcessById(childId);
            // Kill is asynchronous: require the child to exit within a fixed bound.
            await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(2));
            Assert.True(child.HasExited, "Cancellation left the agent's child process alive.");
        }
        catch (ArgumentException) { }
    }

    [Fact]
    public async Task TerminateToleratesAChildThatExitedBeforeItsInputClosed()
    {
        if (OperatingSystem.IsWindows()) return;
        using var process = Process.Start(new ProcessStartInfo("/bin/sh") { UseShellExecute = false, RedirectStandardInput = true, ArgumentList = { "-c", "exit 0" } })!;
        await process.WaitForExitAsync();
        // Callers swallow a failed write to an exited child, which leaves the pipe marked broken.
        try { await process.StandardInput.WriteLineAsync("{\"type\":\"cancel\"}"); } catch (IOException) { }
        await ProcessAgentAdapter.TerminateAsync(process, TimeSpan.Zero);
    }

    [Theory]
    [InlineData("completed", false)]
    [InlineData("needs_user", false)]
    [InlineData("failed", true)]
    [InlineData("cancelled", false)]
    public async Task EveryStartedProcessOutcomeCleansOnlyAfterExitAndPreservesResult(string outcome, bool cleanupFails)
    {
        if (OperatingSystem.IsWindows()) return;
        using var temp = new TempDir();
        var json = "{\"type\":\"result\",\"structured_output\":{\"outcome\":\"" + outcome
            + "\",\"summary\":\"synthetic\",\"nextAction\":\"none\",\"data\":{\"mock\":false,\"attemptId\":null,\"receipt\":null,\"taskKind\":null}}}";
        var script = outcome switch
        {
            "failed" => "exit 7",
            "cancelled" => "sleep 20 & wait",
            _ => "printf '%s\\n' '" + json + "'",
        };
        var adapter = new CleanupTrackingAdapter(new() { PersonalRoot = temp.Root, CancelGrace = TimeSpan.FromMilliseconds(20) }, script, temp.Root)
        { CleanupFails = cleanupFails };
        var scope = new WorkerBrowserScope(temp.Root, Guid.NewGuid().ToString("D"), Guid.NewGuid().ToString("D"),
            Guid.NewGuid().ToString("D"), "synthetic-owner", 1, new("http://127.0.0.1:4101"), "synthetic-token", DateTimeOffset.UtcNow);
        using var cancellation = new CancellationTokenSource();
        var run = adapter.RunAsync(Context(temp.Root, new(Path.Combine(temp.Root, "broker.json"), [], false, [], scope)), cancellation.Token);
        if (outcome == "cancelled")
        {
            var deadline = Stopwatch.StartNew();
            while (!File.Exists(Path.Combine(temp.Root, "cli.pid")) && deadline.Elapsed < TimeSpan.FromSeconds(2)) await Task.Delay(10);
            Assert.True(File.Exists(Path.Combine(temp.Root, "cli.pid")));
            cancellation.Cancel();
        }
        var result = await run.WaitAsync(TimeSpan.FromSeconds(3));
        Assert.Equal(outcome, result.Status);
        Assert.Equal(1, adapter.CleanupCalls);
        Assert.False(adapter.CliAliveAtCleanup);
    }
}
