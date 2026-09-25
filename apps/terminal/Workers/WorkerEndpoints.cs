using System.Text.Json;

namespace JobPilot.Terminal.Workers;

public static class WorkerEndpoints
{
    public static IServiceCollection AddStructuredWorkers(this IServiceCollection services)
    {
        services.AddSingleton<WorkerOptions>();
        services.AddSingleton<PrivateTaskStore>();
        services.AddSingleton<IWorkerAuthentication, WorkerAuthentication>();
        services.AddSingleton<IWorkerBroker, ConfiguredWorkerBroker>();
        services.AddSingleton<IWorkerAttemptApi, WorkerAttemptApi>();
        services.AddSingleton<IWorkerHandoffApi, WorkerHandoffApi>();
        services.AddSingleton<IWorkerHandoffBrowserFactory, WorkerHandoffBrowserFactory>();
        services.AddSingleton<WorkerHandoffService>();
        services.AddHostedService(sp => sp.GetRequiredService<WorkerHandoffService>());
        services.AddSingleton<CodexSupervisorAdapter>();
        services.AddSingleton<ClaudeWorkerAdapter>();
        services.AddSingleton<MockAgentAdapter>();
        services.AddSingleton<WorkerProviderCatalog>();
        services.AddSingleton<WorkerTaskService>();
        services.AddHostedService(sp => sp.GetRequiredService<WorkerTaskService>());
        services.ConfigureHttpJsonOptions(options => options.SerializerOptions.TypeInfoResolverChain.Insert(0, WorkerJsonContext.Default));
        return services;
    }

    public static WebApplication MapStructuredWorkers(this WebApplication app)
    {
        var group = app.MapGroup("/workers");
        group.AddEndpointFilter(async (context, next) =>
        {
            var http = context.HttpContext;
            try
            {
                var auth = http.RequestServices.GetRequiredService<IWorkerAuthentication>();
                var identity = await auth.AuthenticateAsync(http.Request.Headers.Authorization.ToString(), http.RequestAborted);
                if (identity is null) return Results.Problem("A valid private API bearer token is required.", statusCode: 401);
                http.Items[typeof(WorkerIdentity)] = identity;
                return await next(context);
            }
            catch (WorkerRequestException ex) { return Results.Problem(ex.Message, statusCode: ex.StatusCode); }
            catch (HttpRequestException) { return Results.Problem("Private API authentication is unavailable.", statusCode: 503); }
            catch (OperationCanceledException) { return Results.Problem("Private API authentication timed out.", statusCode: 503); }
            catch (JsonException) { return Results.Problem("Request or private API response contained invalid JSON.", statusCode: 400); }
        });
        group.MapGet("/capabilities", async (WorkerOptions options, WorkerProviderCatalog providers, IWorkerBroker broker) =>
        {
            var installed = await providers.GetAsync();
            var codex = installed.FirstOrDefault(provider => provider.Id == "codex");
            var ready = CodexSupervisorPolicy.PlatformSupported && codex is { Installed: true } && CodexSupervisorPolicy.SupportsVersion(codex.Version);
            var approval = broker is ConfiguredWorkerBroker configured ? configured.ProviderScope() : new WorkerProviderScope(false, null, "Provider boundary is unavailable.");
            return Results.Json(new WorkerCapabilities(true, true,
                options.McpConfigPath is { } path && File.Exists(path), (int)options.Timeout.TotalSeconds,
                (int)options.HeartbeatInterval.TotalSeconds, (int)options.LeaseDuration.TotalSeconds, options.MaxPreSubmissionRetries,
                installed, ready, ready ? null : CodexSupervisorPolicy.Unavailable,
                approval.Approved, approval.Scope, approval.BlockReason), WorkerJsonContext.Default.WorkerCapabilities);
        });
        group.MapPost("/tasks", async (HttpContext http, WorkerTaskService tasks) =>
        {
            using var memory = new MemoryStream();
            var buffer = new byte[4096];
            int read;
            while ((read = await http.Request.Body.ReadAsync(buffer, http.RequestAborted)) > 0)
            {
                if (memory.Length + read > 128 * 1024) throw new WorkerRequestException("Task request exceeds 128 KiB.", 413);
                memory.Write(buffer, 0, read);
            }
            var request = JsonSerializer.Deserialize(memory.ToArray(), WorkerJsonContext.Default.AgentTaskRequest)
                ?? throw new WorkerRequestException("Task request is required.");
            return Results.Json(tasks.Start(Identity(http), request), WorkerJsonContext.Default.AgentTaskSnapshot, statusCode: 202);
        });
        group.MapGet("/tasks/{taskId}", (string taskId, HttpContext http, WorkerTaskService tasks) =>
            Snapshot(tasks.Get(Identity(http).UserId, taskId)));
        group.MapPost("/tasks/{taskId}/cancel", (string taskId, HttpContext http, WorkerTaskService tasks) =>
            Snapshot(tasks.Cancel(Identity(http).UserId, taskId)));
        group.MapPost("/tasks/{taskId}/resume", (string taskId, HttpContext http, WorkerTaskService tasks) =>
            Snapshot(tasks.Resume(Identity(http), taskId)));
        group.MapGet("/handoffs/{attemptId}", async (string attemptId, HttpContext http, WorkerHandoffService handoffs) =>
        {
            var state = await handoffs.GetAsync(Identity(http), attemptId, http.RequestAborted);
            return state is null ? Results.Problem("Browser handoff was not found.", statusCode: 404)
                : Results.Json(state, WorkerJsonContext.Default.WorkerHandoffSnapshot);
        });
        group.MapPost("/handoffs/{attemptId}/open", async (string attemptId, HttpContext http, WorkerHandoffService handoffs) =>
            Results.Json(await handoffs.OpenAsync(Identity(http), attemptId, http.RequestAborted), WorkerJsonContext.Default.WorkerHandoffSnapshot));
        group.MapPost("/handoffs/{attemptId}/resume", async (string attemptId, HttpContext http, WorkerHandoffService handoffs) =>
            Results.Json(await handoffs.ResumeAsync(Identity(http), attemptId, http.RequestAborted), WorkerJsonContext.Default.WorkerHandoffSnapshot));
        group.MapPost("/handoffs/{attemptId}/cancel", async (string attemptId, HttpContext http, WorkerHandoffService handoffs) =>
            Results.Json(await handoffs.CancelAsync(Identity(http), attemptId, http.RequestAborted), WorkerJsonContext.Default.WorkerHandoffSnapshot));
        return app;
    }

    private static WorkerIdentity Identity(HttpContext context) => (WorkerIdentity)context.Items[typeof(WorkerIdentity)]!;
    private static IResult Snapshot(AgentTaskSnapshot? snapshot) => snapshot is null
        ? Results.Problem("Task not found.", statusCode: 404)
        : Results.Json(snapshot, WorkerJsonContext.Default.AgentTaskSnapshot);
}
