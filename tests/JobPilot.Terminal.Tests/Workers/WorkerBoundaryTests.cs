using System.Text.Json;
using JobPilot.Terminal.Workers;
using Xunit;
using static JobPilot.Terminal.Tests.WorkerFixtures;

namespace JobPilot.Terminal.Tests;

public sealed class WorkerBoundaryTests
{
    [Theory]
    [InlineData("https://example.com")]
    [InlineData("http://localhost:4101/not-an-origin")]
    [InlineData("http://user:password@localhost:4101")]
    public void RejectsNonPrivateOrCredentialBearingApiOrigins(string url)
    {
        Assert.Throws<WorkerRequestException>(() => new WorkerOptions { ApiUrl = url }.PrivateApiOrigin());
    }

    [Fact]
    public void RejectsPrivateRootInsideGitAndInvalidTaskContracts()
    {
        using var temp = new TempDir();
        Directory.CreateDirectory(Path.Combine(temp.Root, ".git"));
        Assert.Throws<WorkerRequestException>(() => new PrivateTaskStore(new() { PersonalRoot = Path.Combine(temp.Root, "private") }));
        using var other = new TempDir();
        using var service = Service(new() { PersonalRoot = other.Root });
        Assert.Throws<WorkerRequestException>(() => service.Start(Identity, Request() with { TaskId = "../escape" }));
        Assert.Throws<WorkerRequestException>(() => service.Start(Identity, Request() with { Adapter = "shell" }));
        Assert.Throws<WorkerRequestException>(() => service.Start(Identity, Request() with { Kind = "arbitrary_command" }));
        Assert.Throws<WorkerRequestException>(() => service.Start(Identity, Request() with { InputHash = new string('0', 64) }));
    }

    [Fact]
    public async Task ResumeKeepsCanonicalHashAfterWhitespaceAndRejectsTamperedCheckpoint()
    {
        using var temp = new TempDir();
        var options = new WorkerOptions { PersonalRoot = temp.Root };
        var request = Request("fail") with { Input = JsonDocument.Parse("{ \"mockScenario\" : \"fail\" }").RootElement.Clone() };
        using (var first = Service(options))
        {
            first.Start(Identity, request);
            await Finished(first, request.TaskId);
            await first.StopAsync(CancellationToken.None);
        }
        using (var resumed = Service(options))
        {
            resumed.Resume(Identity, request.TaskId);
            Assert.Equal(2, (await Finished(resumed, request.TaskId)).Attempt);
            await resumed.StopAsync(CancellationToken.None);
        }
        var path = Path.Combine(new PrivateTaskStore(options).TaskDirectory(Identity.UserId, request.TaskId), "state.json");
        var text = File.ReadAllText(path).Replace("\"mockScenario\":\"fail\"", "\"mockScenario\":\"success\"");
        File.WriteAllText(path, text);
        using var last = Service(options);
        Assert.Throws<WorkerRequestException>(() => last.Resume(Identity, request.TaskId));
    }

    [Fact]
    public async Task LeaseFilePreventsTwoHostInstancesUsingTheSameUserSlot()
    {
        using var temp = new TempDir();
        var options = new WorkerOptions { PersonalRoot = temp.Root };
        using var first = Service(options);
        using var second = Service(options);
        var request = Request("wait");
        first.Start(Identity, request);
        Assert.Equal(409, Assert.Throws<WorkerRequestException>(() => second.Start(Identity, Request())).StatusCode);
        first.Cancel(Identity.UserId, request.TaskId);
        await first.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task AcceptedQueueHasLeaseAndRestartCanResumeAfterExpiry()
    {
        using var temp = new TempDir();
        var options = new WorkerOptions { PersonalRoot = temp.Root };
        var request = Request();
        AgentTaskSnapshot accepted;
        using (var first = Service(options))
        {
            accepted = first.Start(Identity, request);
            Assert.Equal("queued", accepted.Status);
            Assert.NotNull(accepted.HeartbeatAt);
            Assert.Equal(accepted.HeartbeatAt + TimeSpan.FromSeconds(90), accepted.LeaseExpiresAt);
            await first.StopAsync(CancellationToken.None);
        }

        // Replay exactly the acceptance checkpoint, as if the host died before ExecuteAsync.
        var store = new PrivateTaskStore(options);
        var savedRequest = request with { InputHash = accepted.InputHash };
        store.Write(Identity.UserId, new(savedRequest, accepted));
        using var restarted = Service(options);
        Assert.Equal("queued", restarted.Get(Identity.UserId, request.TaskId)!.Status);
        store.Write(Identity.UserId, new(savedRequest, accepted with
        {
            LeaseExpiresAt = DateTimeOffset.UtcNow.AddSeconds(-1),
        }));
        Assert.Equal("interrupted", restarted.Get(Identity.UserId, request.TaskId)!.Status);
        var resumed = restarted.Resume(Identity, request.TaskId);
        Assert.Equal("queued", resumed.Status);
        Assert.True(resumed.LeaseExpiresAt > DateTimeOffset.UtcNow);
        Assert.Equal("completed", (await Finished(restarted, request.TaskId)).Status);
        await restarted.StopAsync(CancellationToken.None);
    }
}
