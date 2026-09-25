using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using JobPilot.Terminal.Workers;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;
using Xunit;
using static JobPilot.Terminal.Tests.WorkerFixtures;

namespace JobPilot.Terminal.Tests;

public sealed class WorkerEndpointTests
{
    private sealed class FakeAuthentication : IWorkerAuthentication
    {
        public Task<WorkerIdentity?> AuthenticateAsync(string authorization, CancellationToken ct) =>
            Task.FromResult<WorkerIdentity?>(authorization == "Bearer test" ? Identity : null);
    }

    [Fact]
    public async Task AuthenticatedHttpMockStartStatusCancelAndResumeUseSameLifecycle()
    {
        using var temp = new TempDir();
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { ContentRootPath = temp.Root, EnvironmentName = "Testing" });
        builder.Configuration["Kestrel:Endpoints:Http:Url"] = "http://127.0.0.1:0";
        builder.Services.AddStructuredWorkers();
        builder.Services.AddSingleton(new WorkerOptions { PersonalRoot = temp.Root });
        builder.Services.AddSingleton<IWorkerAuthentication, FakeAuthentication>();
        await using var app = builder.Build();
        app.MapStructuredWorkers();
        app.Urls.Add("http://127.0.0.1:0");
        await app.StartAsync();
        using var client = new HttpClient { BaseAddress = new Uri(app.Urls.Single()) };
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/workers/capabilities")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsync("/workers/handoffs/" + Guid.NewGuid() + "/open", null)).StatusCode);
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "test");
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/workers/capabilities")).StatusCode);
        var request = Request("wait");
        var body = JsonSerializer.Serialize(request, WorkerJsonContext.Default.AgentTaskRequest);
        var created = await client.PostAsync("/workers/tasks", new StringContent(body, Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.Accepted, created.StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/workers/tasks/" + request.TaskId)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsync("/workers/tasks/" + request.TaskId + "/cancel", null)).StatusCode);
        var service = app.Services.GetRequiredService<WorkerTaskService>();
        Assert.Equal("cancelled", (await Finished(service, request.TaskId)).Status);
        await Task.Delay(30);
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsync("/workers/tasks/" + request.TaskId + "/resume", null)).StatusCode);
        await client.PostAsync("/workers/tasks/" + request.TaskId + "/cancel", null);
        await app.StopAsync();
    }
}
