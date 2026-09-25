using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using JobPilot.Terminal.Workers;
using Xunit;
using static JobPilot.Terminal.Tests.WorkerFixtures;

namespace JobPilot.Terminal.Tests;

public sealed class WorkerAttemptApiTests
{
    private sealed class AttemptHandler(string state, string owner, int generation, bool expired, bool receipt) : HttpMessageHandler
    {
        public int Reads { get; private set; }
        public int Writes { get; private set; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Assert.Equal(Identity.Bearer, request.Headers.Authorization!.Parameter);
            Assert.Equal("127.0.0.1", request.RequestUri!.Host);
            if (request.Method == HttpMethod.Post)
            {
                Writes++;
                Assert.EndsWith("/checkpoint", request.RequestUri.AbsolutePath);
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Conflict));
            }
            Reads++;
            var body = new JsonObject
            {
                ["id"] = "attempt", ["state"] = state, ["leaseOwner"] = owner, ["leaseGeneration"] = generation,
                ["leaseExpiresAt"] = DateTimeOffset.UtcNow.AddMinutes(expired ? -1 : 1).ToString("O"),
                ["receipt"] = receipt ? new JsonObject { ["outcome"] = "submitted" } : null,
            };
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json") });
        }
    }

    [Theory]
    [InlineData("submitting", "owner", 1, false, false, true)]
    [InlineData("submitting", "owner", 1, true, false, false)]
    [InlineData("submitting", "other-owner", 1, false, false, false)]
    [InlineData("submitting", "owner", 2, false, false, false)]
    [InlineData("submitted", "owner", 2, true, true, true)]
    [InlineData("submitted", "owner", 2, false, false, false)]
    [InlineData("submission_uncertain", "owner", 1, false, false, false)]
    public async Task SlowReceiptWaitHonorsSubmitLeaseAndVerifiedCompletion(string state, string owner, int generation, bool expired, bool receipt, bool expected)
    {
        var handler = new AttemptHandler(state, owner, generation, expired, receipt);
        using var api = new WorkerAttemptApi(new() { ApiUrl = "http://127.0.0.1:4101" }, new HttpClient(handler));
        var task = Request(adapter: "claude", kind: "apply") with
        {
            Input = JsonDocument.Parse("{\"attemptId\":\"attempt\",\"leaseOwner\":\"owner\",\"leaseGeneration\":1}").RootElement.Clone(),
        };
        Assert.Equal(expected, await api.RenewAsync(Identity, task, CancellationToken.None));
        Assert.Equal(1, handler.Reads);
        Assert.Equal(1, handler.Writes);
    }
}
