using System.Text.Json;
using JobPilot.Terminal.Workers;
using Xunit;
using static JobPilot.Terminal.Tests.WorkerFixtures;

namespace JobPilot.Terminal.Tests;

public sealed class WorkerTaskServiceTests
{
    [Fact]
    public async Task MockCompletesAndPersistsPrivateCheckpointWithoutBearer()
    {
        using var temp = new TempDir();
        var options = new WorkerOptions { PersonalRoot = temp.Root };
        using var service = Service(options);
        var request = Request();
        service.Start(Identity, request);
        var state = await Finished(service, request.TaskId);
        Assert.Equal("completed", state.Status);
        Assert.True(state.Result!.Value.GetProperty("data").GetProperty("mock").GetBoolean());
        Assert.False(state.SubmissionPossible);
        var path = Path.Combine(new PrivateTaskStore(options).TaskDirectory(Identity.UserId, request.TaskId), "state.json");
        Assert.DoesNotContain(Identity.Bearer, File.ReadAllText(path));
        if (!OperatingSystem.IsWindows()) Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(path));
        using var reopened = Service(options);
        Assert.Equal(state.InputHash, reopened.Get(Identity.UserId, request.TaskId)!.InputHash);
        Assert.Equal("completed", reopened.Get(Identity.UserId, request.TaskId)!.Status);
        Assert.Null(reopened.Get("different-user", request.TaskId));
        await service.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task DuplicateTaskIsIdempotentButChangedInputIsRejected()
    {
        using var temp = new TempDir();
        using var service = Service(new() { PersonalRoot = temp.Root });
        var request = Request("wait");
        service.Start(Identity, request);
        Assert.Equal(request.TaskId, service.Start(Identity, request).TaskId);
        var changed = request with { Input = JsonDocument.Parse("{\"changed\":true}").RootElement.Clone() };
        Assert.Equal(409, Assert.Throws<WorkerRequestException>(() => service.Start(Identity, changed)).StatusCode);
        service.Cancel(Identity.UserId, request.TaskId);
        await service.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task OneSupervisorAndOneWorkerCanRunButSecondWorkerCannot()
    {
        using var temp = new TempDir();
        using var service = Service(new() { PersonalRoot = temp.Root });
        var worker = Request("wait");
        var supervisor = Request("wait", "supervisor");
        service.Start(Identity, worker);
        service.Start(Identity, supervisor);
        Assert.Equal(409, Assert.Throws<WorkerRequestException>(() => service.Start(Identity, Request())).StatusCode);
        service.Cancel(Identity.UserId, worker.TaskId);
        service.Cancel(Identity.UserId, supervisor.TaskId);
        await service.StopAsync(CancellationToken.None);
        Assert.Equal("cancelled", service.Get(Identity.UserId, worker.TaskId)!.Status);
    }

    [Fact]
    public async Task TimeoutAndHeartbeatAreRecorded()
    {
        using var temp = new TempDir();
        using var service = Service(new() { PersonalRoot = temp.Root, Timeout = TimeSpan.FromMilliseconds(100), HeartbeatInterval = TimeSpan.FromMilliseconds(20) });
        var request = Request("wait");
        service.Start(Identity, request);
        var state = await Finished(service, request.TaskId);
        Assert.Equal("timed_out", state.Status);
        Assert.Contains(state.Events, entry => entry.Type == "heartbeat");
        Assert.Null(state.LeaseExpiresAt);
        await service.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task PreSubmissionRetryIsBoundedAndPossibleSubmissionNeverRetries()
    {
        using var temp = new TempDir();
        using var service = Service(new() { PersonalRoot = temp.Root });
        var retry = Request("retry");
        service.Start(Identity, retry);
        Assert.Equal(2, (await Finished(service, retry.TaskId)).Attempt);
        await service.StopAsync(CancellationToken.None);
        using var second = Service(new() { PersonalRoot = temp.Root }, new FakeWorkerBroker(true, true));
        var apply = Request("retry", adapter: "claude", kind: "apply");
        second.Start(Identity, apply);
        var state = await Finished(second, apply.TaskId);
        Assert.Equal("outcome_unknown", state.Status);
        Assert.Equal(1, state.Attempt);
        await second.StopAsync(CancellationToken.None);
        Assert.Throws<WorkerRequestException>(() => second.Resume(Identity, apply.TaskId));
    }

    [Fact]
    public async Task MissingBrokerBlocksRealWorkerAndDoesNotClaimSuccess()
    {
        using var temp = new TempDir();
        using var service = Service(new() { PersonalRoot = temp.Root });
        var request = Request(adapter: "claude", kind: "apply");
        service.Start(Identity, request);
        var state = await Finished(service, request.TaskId);
        Assert.Equal("blocked", state.Status);
        Assert.Contains("broker", state.Error);
        Assert.Null(state.Result);
        await service.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task ClaimedSuccessRequiresServerReceipt()
    {
        using var temp = new TempDir();
        using var service = Service(new() { PersonalRoot = temp.Root }, new FakeWorkerBroker(true, true));
        var request = Request(adapter: "claude", kind: "apply");
        service.Start(Identity, request);
        Assert.Equal("outcome_unknown", (await Finished(service, request.TaskId)).Status);
        await service.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task LostApiLeaseStopsWorker()
    {
        using var temp = new TempDir();
        var api = new FakeWorkerAttemptApi();
        using var service = Service(new() { PersonalRoot = temp.Root, HeartbeatInterval = TimeSpan.FromMilliseconds(20) }, new FakeWorkerBroker(true), api);
        var request = Request("wait", adapter: "claude");
        service.Start(Identity, request);
        await Task.Delay(50);
        api.Renew = false;
        Assert.Equal("blocked", (await Finished(service, request.TaskId)).Status);
        Assert.True(api.Renewals >= 2);
        Assert.Equal(1, api.Cancellations);
        await service.StopAsync(CancellationToken.None);
    }
}
