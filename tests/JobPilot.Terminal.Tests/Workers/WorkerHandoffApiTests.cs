using System.Net;
using System.Text;
using System.Text.Json;
using JobPilot.Terminal.Workers;
using Xunit;
using static JobPilot.Terminal.Tests.WorkerFixtures;

namespace JobPilot.Terminal.Tests;

public sealed class WorkerHandoffApiTests
{
    private sealed class Handler(WorkerHandoffSnapshot response, bool changeScope = false) : HttpMessageHandler
    {
        public string? Body { get; private set; }
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Assert.Equal(Identity.Bearer, request.Headers.Authorization!.Parameter);
            Assert.Equal("127.0.0.1", request.RequestUri!.Host);
            Body = await request.Content!.ReadAsStringAsync(ct);
            var opening = request.RequestUri.AbsolutePath.EndsWith("/open", StringComparison.Ordinal);
            var state = response with { LeaseGeneration = response.LeaseGeneration + (opening ? 1 : 0) + (changeScope ? 1 : 0) };
            return new(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(state, WorkerJsonContext.Default.WorkerHandoffSnapshot), Encoding.UTF8, "application/json") };
        }
    }

    private static WorkerHandoffSnapshot State() => new()
    {
        HandoffId = Guid.NewGuid().ToString(), AttemptId = Guid.NewGuid().ToString(), RecordId = Guid.NewGuid().ToString(),
        ProfileKey = "profile", AllowedOrigin = "https://example.test", Reason = "login", Status = "open",
        LeaseOwner = "owner", LeaseGeneration = 1, LeaseExpiresAt = DateTimeOffset.UtcNow.AddMinutes(1),
    };

    [Fact]
    public async Task ApiSendsOnlyScopedLeaseAndProofWithoutBearerInBody()
    {
        var state = State();
        var handler = new Handler(state);
        using var api = new WorkerHandoffApi(new(), new HttpClient(handler));
        var opened = await api.TransitionAsync(Identity, state, "open", CancellationToken.None);
        Assert.Equal(state.LeaseGeneration + 1, opened.LeaseGeneration);
        Assert.DoesNotContain("proofHash", handler.Body!);
        Assert.DoesNotContain(Identity.Bearer, handler.Body!);
        await api.TransitionAsync(Identity, state, "resume", CancellationToken.None, new string('f', 64));
        using var body = JsonDocument.Parse(handler.Body!);
        Assert.Equal(new string('f', 64), body.RootElement.GetProperty("proofHash").GetString());
        Assert.Equal(4, body.RootElement.EnumerateObject().Count());
    }

    [Fact]
    public async Task ApiRejectsOwnershipChangeAndResumeWithoutVerificationProof()
    {
        var state = State();
        using var api = new WorkerHandoffApi(new(), new HttpClient(new Handler(state, true)));
        await Assert.ThrowsAsync<WorkerRequestException>(() => api.TransitionAsync(Identity, state, "heartbeat", CancellationToken.None));
        await Assert.ThrowsAsync<WorkerRequestException>(() => api.TransitionAsync(Identity, state, "resume", CancellationToken.None));
        await Assert.ThrowsAsync<WorkerRequestException>(() => api.TransitionAsync(Identity, state, "open", CancellationToken.None));
    }
}
