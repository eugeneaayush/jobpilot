using System.Diagnostics;
using System.Text.Json;
using JobPilot.Terminal.Workers;
using Xunit;
using static JobPilot.Terminal.Tests.WorkerFixtures;

namespace JobPilot.Terminal.Tests;

public sealed class WorkerHandoffTests
{
    private sealed class FakeApi : IWorkerHandoffApi
    {
        public WorkerHandoffSnapshot State { get; set; } = new()
        {
            HandoffId = Guid.NewGuid().ToString(), AttemptId = Guid.NewGuid().ToString(), RecordId = Guid.NewGuid().ToString(),
            ProfileKey = "profile-opaque", AllowedOrigin = "https://example.test", Reason = "login", Status = "parked",
            LeaseOwner = "handoff-owner", LeaseGeneration = 1, LeaseExpiresAt = DateTimeOffset.UtcNow.AddMinutes(2),
        };
        public List<string> Actions { get; } = [];
        public string? Proof { get; private set; }
        public Func<bool>? BrowserClosed { get; init; }
        public bool HeartbeatFails { get; set; }
        public Task<WorkerHandoffSnapshot?> GetAsync(WorkerIdentity identity, string attemptId, CancellationToken ct) => Task.FromResult<WorkerHandoffSnapshot?>(State);
        public Task<WorkerHandoffSnapshot> TransitionAsync(WorkerIdentity identity, WorkerHandoffSnapshot current, string action, CancellationToken ct, string? proofHash = null)
        {
            Actions.Add(action);
            if (action == "heartbeat" && HeartbeatFails) throw new WorkerRequestException("Synthetic lease lost", 409);
            if (action == "resume") { Assert.True(BrowserClosed?.Invoke() ?? true); Proof = proofHash; }
            State = State with { Status = action switch { "open" => "open", "resume" => "resolved", "cancel" => "cancelled", _ => State.Status } };
            return Task.FromResult(State);
        }
    }
    private sealed class Browser : IWorkerHandoffBrowser
    {
        public bool IsRunning { get; private set; }
        public string? Proof { get; set; }
        public Task OpenAsync(CancellationToken ct) { IsRunning = true; return Task.CompletedTask; }
        public Task<string?> ResumeAsync(CancellationToken ct) => Task.FromResult(Proof);
        public Task CloseAsync(CancellationToken ct) { IsRunning = false; return Task.CompletedTask; }
        public ValueTask DisposeAsync() { IsRunning = false; return ValueTask.CompletedTask; }
    }
    private sealed class Factory(Browser browser) : IWorkerHandoffBrowserFactory
    {
        public IWorkerHandoffBrowser Create(WorkerIdentity identity, WorkerHandoffSnapshot handoff, string workingDirectory) => browser;
    }

    [Fact]
    public async Task HandoffHoldsExclusiveWorkerProfileAndResumesOnlyAfterVerifiedBrowserCloses()
    {
        using var temp = new TempDir();
        var options = new WorkerOptions { PersonalRoot = temp.Root };
        var store = new PrivateTaskStore(options);
        var browser = new Browser();
        var api = new FakeApi { BrowserClosed = () => !browser.IsRunning };
        var service = new WorkerHandoffService(options, store, api, new Factory(browser));
        var opened = await service.OpenAsync(Identity, api.State.AttemptId, CancellationToken.None);
        Assert.True(opened.BrowserOpen);
        Assert.Throws<WorkerRequestException>(() => store.AcquireSlot(Identity.UserId, "worker"));
        using (store.AcquireSlot(Identity.UserId, "supervisor")) { }
        var blocked = await service.ResumeAsync(Identity, api.State.AttemptId, CancellationToken.None);
        Assert.True(blocked.BrowserOpen);
        Assert.DoesNotContain("resume", api.Actions);
        browser.Proof = new string('a', 64);
        var resolved = await service.ResumeAsync(Identity, api.State.AttemptId, CancellationToken.None);
        Assert.Equal("resolved", resolved.Status);
        Assert.False(resolved.BrowserOpen);
        Assert.Equal(browser.Proof, api.Proof);
        using (store.AcquireSlot(Identity.UserId, "worker")) { }
        Assert.DoesNotContain("submit", api.Actions);
        var saved = Directory.GetFiles(temp.Root, "state.json", SearchOption.AllDirectories).Single();
        Assert.DoesNotContain(Identity.Bearer, File.ReadAllText(saved));
        if (!OperatingSystem.IsWindows()) Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(saved));
    }

    [Fact]
    public async Task RestartCannotClaimBrowserOpenOrResumeWithoutAHeadedSession()
    {
        using var temp = new TempDir();
        var options = new WorkerOptions { PersonalRoot = temp.Root };
        var api = new FakeApi();
        api.State = api.State with { Status = "open" };
        var service = new WorkerHandoffService(options, new(options), api, new Factory(new()));
        Assert.False((await service.GetAsync(Identity, api.State.AttemptId, CancellationToken.None))!.BrowserOpen);
        await Assert.ThrowsAsync<WorkerRequestException>(() => service.ResumeAsync(Identity, api.State.AttemptId, CancellationToken.None));
        Assert.Equal("cancelled", (await service.CancelAsync(Identity, api.State.AttemptId, CancellationToken.None)).Status);
        Assert.True((await service.OpenAsync(Identity, api.State.AttemptId, CancellationToken.None)).BrowserOpen);
        await service.StopAsync(CancellationToken.None);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task LeaseLossOrWallClockDeadlineClosesBrowserAndReleasesOnlyWorkerSlot(bool lost)
    {
        using var temp = new TempDir();
        var options = new WorkerOptions { PersonalRoot = temp.Root, HeartbeatInterval = TimeSpan.FromMilliseconds(10), Timeout = TimeSpan.FromMilliseconds(lost ? 5000 : 20) };
        var browser = new Browser();
        var api = new FakeApi { HeartbeatFails = lost };
        var store = new PrivateTaskStore(options);
        var service = new WorkerHandoffService(options, store, api, new Factory(browser));
        await service.StartAsync(CancellationToken.None);
        await service.OpenAsync(Identity, api.State.AttemptId, CancellationToken.None);
        for (var index = 0; index < 100 && browser.IsRunning; index++) await Task.Delay(10);
        Assert.False(browser.IsRunning);
        using (store.AcquireSlot(Identity.UserId, "worker")) { }
        await service.StopAsync(CancellationToken.None);
    }

    [Theory]
    [InlineData("https://user:secret@example.test")]
    [InlineData("https://example.test/?token=secret")]
    [InlineData("file:///tmp/sensitive")]
    [InlineData("https://example.test/login")]
    public void HandoffScopeRejectsCredentialsPathsAndNonHttpOrigins(string origin)
    {
        var value = new FakeApi().State with { AllowedOrigin = origin };
        Assert.Throws<WorkerRequestException>(() => WorkerHandoffValidation.Check(value, value.AttemptId));
    }

    [Fact]
    public async Task ProcessTransportAcceptsOnlyFixedEventsAndDoesNotWriteRawOutput()
    {
        if (OperatingSystem.IsWindows()) return;
        using var temp = new TempDir();
        var path = Path.Combine(temp.Root, "fixture.sh");
        File.WriteAllText(path, "read line\nprintf '%s\\n' '{\"type\":\"ready\"}'\nread line\nprintf '%s\\n' '{\"type\":\"resolved\",\"proofHash\":\"" + new string('a', 64) + "\"}'\nread line\n");
        var start = new ProcessStartInfo("/bin/sh") { WorkingDirectory = temp.Root, UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, ArgumentList = { path } };
        await using var browser = new WorkerHandoffBrowser(start, TimeSpan.FromMilliseconds(50));
        await browser.OpenAsync(CancellationToken.None);
        Assert.Equal(new string('a', 64), await browser.ResumeAsync(CancellationToken.None));
        Assert.Single(Directory.GetFiles(temp.Root));
    }

    [Fact]
    public async Task ProcessTransportRejectsPageContentInEvents()
    {
        if (OperatingSystem.IsWindows()) return;
        using var temp = new TempDir();
        var path = Path.Combine(temp.Root, "fixture.sh");
        File.WriteAllText(path, "read line\nprintf '%s\\n' '{\"type\":\"ready\",\"pageText\":\"private-canary\"}'\n");
        var start = new ProcessStartInfo("/bin/sh") { WorkingDirectory = temp.Root, UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, ArgumentList = { path } };
        await using var browser = new WorkerHandoffBrowser(start, TimeSpan.Zero);
        await Assert.ThrowsAsync<InvalidDataException>(() => browser.OpenAsync(CancellationToken.None));
    }
}
