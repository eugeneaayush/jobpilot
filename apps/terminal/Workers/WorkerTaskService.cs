using System.Text;
using System.Text.Json;

namespace JobPilot.Terminal.Workers;

public sealed class WorkerTaskService : IHostedService, IDisposable
{
    private sealed class ActiveRun(WorkerIdentity identity, AgentTaskRequest request, AgentTaskSnapshot snapshot, FileStream slot)
    {
        public WorkerIdentity Identity { get; } = identity;
        public AgentTaskRequest Request { get; } = request;
        public AgentTaskSnapshot Snapshot { get; set; } = snapshot;
        public FileStream Slot { get; } = slot;
        public CancellationTokenSource Cancellation { get; } = new();
        public Task Completion { get; set; } = Task.CompletedTask;
        public bool LeaseLost { get; set; }
        public bool BrokerActive { get; set; }
        public Task? Revocation { get; set; }
    }

    private readonly WorkerOptions options;
    private readonly PrivateTaskStore store;
    private readonly IWorkerBroker broker;
    private readonly IWorkerAttemptApi attemptApi;
    private readonly IReadOnlyDictionary<string, IAgentAdapter> adapters;
    private readonly Lock gate = new();
    private readonly Dictionary<string, ActiveRun> active = [];
    private bool stopping;

    public WorkerTaskService(WorkerOptions options, PrivateTaskStore store, IWorkerBroker broker, IWorkerAttemptApi attemptApi,
        CodexSupervisorAdapter codex, ClaudeWorkerAdapter claude, MockAgentAdapter mock)
        : this(options, store, broker, attemptApi, new Dictionary<string, IAgentAdapter> { ["codex"] = codex, ["claude"] = claude, ["mock"] = mock }) { }

    internal WorkerTaskService(WorkerOptions options, PrivateTaskStore store, IWorkerBroker broker, IWorkerAttemptApi attemptApi, IReadOnlyDictionary<string, IAgentAdapter> adapters)
    {
        this.options = options;
        this.store = store;
        this.broker = broker;
        this.attemptApi = attemptApi;
        this.adapters = adapters;
    }

    public AgentTaskSnapshot Start(WorkerIdentity identity, AgentTaskRequest request)
    {
        request = Validate(request);
        lock (gate)
        {
            if (stopping) throw new WorkerRequestException("The task host is stopping.", 503);
            if (store.Read(identity.UserId, request.TaskId) is { } prior)
            {
                if (prior.Snapshot.InputHash != request.InputHash || prior.Request.Role != request.Role
                    || prior.Request.Adapter != request.Adapter || prior.Request.Kind != request.Kind)
                    throw new WorkerRequestException("Task ID already belongs to different immutable input.", 409);
                return GetLocked(identity.UserId, request.TaskId)!;
            }
            var snapshot = new AgentTaskSnapshot
            {
                TaskId = request.TaskId, Role = request.Role, Adapter = request.Adapter, Kind = request.Kind,
                InputHash = request.InputHash!, Status = "queued",
            };
            return LaunchLocked(identity, request, snapshot);
        }
    }

    public AgentTaskSnapshot? Get(string userId, string taskId)
    {
        taskId = NormalizeId(taskId);
        lock (gate) return GetLocked(userId, taskId);
    }

    public AgentTaskSnapshot Resume(WorkerIdentity identity, string taskId)
    {
        taskId = NormalizeId(taskId);
        lock (gate)
        {
            if (stopping) throw new WorkerRequestException("The task host is stopping.", 503);
            if (active.TryGetValue(Key(identity.UserId, taskId), out var running)) return running.Snapshot;
            var saved = store.Read(identity.UserId, taskId) ?? throw new WorkerRequestException("Task not found.", 404);
            if (saved.Snapshot.SubmissionPossible)
                throw new WorkerRequestException("Possible submission must be reconciled through a new reconcile task; this task cannot retry.", 409);
            if (saved.Snapshot.Status is "completed" or "needs_user" || saved.Snapshot.Attempt > options.MaxPreSubmissionRetries)
                throw new WorkerRequestException("Task is complete, awaiting input, or has exhausted its bounded attempts.", 409);
            var validated = Validate(saved.Request);
            if (validated.InputHash != saved.Snapshot.InputHash)
                throw new WorkerRequestException("Stored task input no longer matches its checkpoint hash.", 409);
            return LaunchLocked(identity, validated, saved.Snapshot with { Status = "queued", Phase = "resuming", Error = null });
        }
    }

    public AgentTaskSnapshot? Cancel(string userId, string taskId)
    {
        taskId = NormalizeId(taskId);
        lock (gate)
        {
            if (!active.TryGetValue(Key(userId, taskId), out var run)) return GetLocked(userId, taskId);
            SetLocked(run, run.Snapshot with { Status = "cancelling", Phase = "cancelling" }, "cancel", "Cancellation requested.");
            run.Cancellation.Cancel();
            return run.Snapshot;
        }
    }

    private AgentTaskSnapshot LaunchLocked(WorkerIdentity identity, AgentTaskRequest request, AgentTaskSnapshot snapshot)
    {
        if (active.Values.Any(run => run.Identity.UserId == identity.UserId && run.Request.Role == request.Role))
            throw new WorkerRequestException($"This user's {request.Role} slot is already active.", 409);
        var slot = store.AcquireSlot(identity.UserId, request.Role);
        var run = new ActiveRun(identity, request, snapshot, slot);
        try
        {
            var acceptedAt = DateTimeOffset.UtcNow;
            SetLocked(run, snapshot with
            {
                HeartbeatAt = acceptedAt, LeaseExpiresAt = acceptedAt + options.LeaseDuration,
            }, "queued", "Task accepted with immutable input.");
            active.Add(Key(identity.UserId, request.TaskId), run);
            run.Completion = Task.Run(() => ExecuteAsync(run));
            return run.Snapshot;
        }
        catch
        {
            slot.Dispose();
            run.Cancellation.Dispose();
            throw;
        }
    }

    private async Task ExecuteAsync(ActiveRun run)
    {
        using var deadline = new CancellationTokenSource(options.Timeout);
        using var cancel = CancellationTokenSource.CreateLinkedTokenSource(run.Cancellation.Token, deadline.Token);
        using var heartbeatCancel = new CancellationTokenSource();
        var heartbeat = HeartbeatAsync(run, heartbeatCancel.Token);
        WorkerBrokerGrant? grant = null;
        try
        {
            while (true)
            {
                cancel.Token.ThrowIfCancellationRequested();
                AgentTaskSnapshot snapshot;
                string? previousSession;
                lock (gate)
                {
                    previousSession = run.Snapshot.SessionId;
                    var now = DateTimeOffset.UtcNow;
                    SetLocked(run, run.Snapshot with
                    {
                        Attempt = run.Snapshot.Attempt + 1, SessionId = run.Request.Adapter == "codex" ? previousSession : Guid.NewGuid().ToString("D"),
                        Status = "running", Phase = "preparing", HeartbeatAt = now, LeaseExpiresAt = now + options.LeaseDuration,
                    }, "attempt", "Starting a bounded attempt.");
                    snapshot = run.Snapshot;
                }
                var cwd = Path.Combine(store.TaskDirectory(run.Identity.UserId, run.Request.TaskId), $"attempt-{snapshot.Attempt}");
                PrivateTaskStore.EnsureDirectory(cwd);
                if (run.Request.Adapter != "mock" && run.Request.Role == "worker")
                {
                    grant = await broker.AuthorizeAsync(run.Request, run.Identity, cwd, cancel.Token);
                    if (grant is null)
                    {
                        Finish(run, new("blocked", Error: "Scoped application broker is not configured; real execution is blocked."));
                        return;
                    }
                    if (!await attemptApi.RenewAsync(run.Identity, run.Request, cancel.Token))
                        throw new WorkerRequestException("API attempt lease could not be renewed; real execution is blocked.", 409);
                    run.BrokerActive = true;
                }
                lock (gate)
                {
                    SetLocked(run, run.Snapshot with { Phase = "executing", SubmissionPossible = grant?.CanSubmit == true },
                        "execute", grant?.CanSubmit == true ? "Submission-capable execution started; automatic retry is disabled." : "Execution started without submission capability.");
                }
                var context = new AgentRunContext(run.Request, cwd, snapshot.SessionId ?? Guid.NewGuid().ToString("D"), snapshot.Attempt, grant,
                    (type, message) => EmitAsync(run, type, message), previousSession, () => RevokeAsync(run));
                var result = await adapters[run.Request.Adapter].RunAsync(context, cancel.Token);
                if (cancel.IsCancellationRequested) throw new OperationCanceledException(cancel.Token);
                if (grant?.CanSubmit == true && result.Status == "completed"
                    && !await attemptApi.HasSubmissionReceiptAsync(run.Identity, run.Request, cancel.Token))
                    result = new("outcome_unknown", Error: "The API has no verified submission receipt for this attempt.");
                if (result.Retryable && !run.Snapshot.SubmissionPossible && snapshot.Attempt <= options.MaxPreSubmissionRetries)
                {
                    await EmitAsync(run, "retry", "Retrying a pre-submission transport failure within the task deadline.");
                    await Task.Delay(TimeSpan.FromSeconds(snapshot.Attempt), cancel.Token);
                    continue;
                }
                Finish(run, result);
                return;
            }
        }
        catch (OperationCanceledException) when (cancel.IsCancellationRequested)
        {
            await RevokeAsync(run);
            var status = "cancelled";
            var error = "Task cancelled.";
            if (run.LeaseLost)
            {
                status = "blocked";
                error = "API attempt lease was lost; execution stopped.";
            }
            else if (deadline.IsCancellationRequested && !run.Cancellation.IsCancellationRequested)
            {
                status = "timed_out";
                error = "Task reached its wall-clock deadline.";
            }
            Finish(run, new(status, Error: error));
        }
        catch (WorkerRequestException ex)
        {
            Finish(run, new("blocked", Error: ex.Message));
        }
        catch (Exception)
        {
            Finish(run, new("failed", Error: "Task execution failed; inspect its private checkpoint and attempt output."));
        }
        finally
        {
            await heartbeatCancel.CancelAsync();
            try { await heartbeat; } catch (Exception) { }
            if (grant is not null && File.Exists(grant.McpConfigPath)) File.Delete(grant.McpConfigPath);
            lock (gate)
            {
                active.Remove(Key(run.Identity.UserId, run.Request.TaskId));
                run.Slot.Dispose();
                run.Cancellation.Dispose();
            }
        }
    }

    private async Task HeartbeatAsync(ActiveRun run, CancellationToken ct)
    {
        using var timer = new PeriodicTimer(options.HeartbeatInterval);
        while (await timer.WaitForNextTickAsync(ct))
        {
            if (run.BrokerActive)
            {
                bool renewed;
                try { renewed = await attemptApi.RenewAsync(run.Identity, run.Request, ct); }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { return; }
                catch (Exception) { renewed = false; }
                if (!renewed)
                {
                    lock (gate)
                    {
                        run.LeaseLost = true;
                        run.Cancellation.Cancel();
                    }
                    return;
                }
            }
            lock (gate)
            {
                if (run.Snapshot.Phase == "finished") return;
                var now = DateTimeOffset.UtcNow;
                SetLocked(run, run.Snapshot with { HeartbeatAt = now, LeaseExpiresAt = now + options.LeaseDuration }, "heartbeat", "Local task lease renewed.");
            }
        }
    }

    private Task RevokeAsync(ActiveRun run)
    {
        lock (gate) return run.Revocation ??= RevokeOnceAsync(run);
    }

    private async Task RevokeOnceAsync(ActiveRun run)
    {
        if (!run.BrokerActive) return;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        bool revoked;
        try { revoked = await attemptApi.CancelAsync(run.Identity, run.Request, timeout.Token); }
        catch (Exception) { revoked = false; }
        await EmitAsync(run, "revoke", revoked ? "API attempt cancelled before process interruption." : "API cancellation could not be confirmed; local execution is stopping.");
    }

    private Task EmitAsync(ActiveRun run, string type, string message)
    {
        lock (gate)
        {
            var next = type == "session" ? run.Snapshot with { SessionId = message } : run.Snapshot;
            SetLocked(run, next, type, message);
        }
        return Task.CompletedTask;
    }

    private void Finish(ActiveRun run, AgentRunResult result)
    {
        lock (gate)
        {
            var uncertain = run.Snapshot.SubmissionPossible && result.Status != "completed";
            SetLocked(run, run.Snapshot with
            {
                Status = uncertain ? "outcome_unknown" : result.Status, Phase = "finished", Result = result.Result,
                Error = uncertain ? "Execution ended after submission became possible. Reconcile the application before any new attempt." : result.Error,
                LeaseExpiresAt = null,
            }, "finished", uncertain ? "Application outcome requires reconciliation." : $"Task {result.Status}.");
        }
    }

    private AgentTaskSnapshot? GetLocked(string userId, string taskId)
    {
        if (active.TryGetValue(Key(userId, taskId), out var run)) return run.Snapshot;
        var saved = store.Read(userId, taskId);
        if (saved is null) return null;
        var snapshot = saved.Snapshot;
        if (snapshot.Status is "running" or "queued" or "cancelling" && snapshot.LeaseExpiresAt < DateTimeOffset.UtcNow)
            return snapshot with { Status = snapshot.SubmissionPossible ? "outcome_unknown" : "interrupted", Error = "Host task lease expired; explicit resume or reconciliation is required." };
        return snapshot;
    }

    private void SetLocked(ActiveRun run, AgentTaskSnapshot next, string type, string message)
    {
        var sequence = (run.Snapshot.Events.LastOrDefault()?.Sequence ?? 0) + 1;
        var entry = new AgentTaskEvent(sequence, DateTimeOffset.UtcNow, type, message.Length <= 2000 ? message : message[..2000]);
        var events = run.Snapshot.Events.Append(entry).TakeLast(256).ToArray();
        var updated = next with { UpdatedAt = entry.At, Events = events };
        store.Write(run.Identity.UserId, new(run.Request, updated));
        run.Snapshot = updated;
    }

    private AgentTaskRequest Validate(AgentTaskRequest request)
    {
        var id = NormalizeId(request.TaskId);
        if (request.Role is not ("supervisor" or "worker") || request.Adapter is not ("mock" or "codex" or "claude")
            || request.Adapter == "codex" && request.Role != "supervisor" || request.Adapter == "claude" && request.Role != "worker")
            throw new WorkerRequestException("Unsupported task role or adapter pairing.");
        if (request.Role == "supervisor" && request.Kind != "plan"
            || request.Role == "worker" && request.Kind is not ("score" or "prepare_apply" or "apply" or "reconcile"))
            throw new WorkerRequestException("Unsupported bounded task kind.");
        if (request.Input.ValueKind != JsonValueKind.Object || Encoding.UTF8.GetByteCount(request.Input.GetRawText()) > options.MaxInputBytes)
            throw new WorkerRequestException("Task input must be a JSON object of at most 64 KiB.");
        using var bytes = new MemoryStream();
        using (var writer = new Utf8JsonWriter(bytes)) request.Input.WriteTo(writer);
        var compact = Encoding.UTF8.GetString(bytes.ToArray());
        var hash = PrivateTaskStore.Hash(compact);
        if (request.InputHash is not null && request.InputHash != hash) throw new WorkerRequestException("Task input hash does not match.", 409);
        using var canonical = JsonDocument.Parse(compact);
        return request with { TaskId = id, InputHash = hash, Input = canonical.RootElement.Clone() };
    }

    private static string NormalizeId(string taskId) => Guid.TryParse(taskId, out var id)
        ? id.ToString("D") : throw new WorkerRequestException("taskId must be a UUID.");
    private static string Key(string userId, string taskId) => userId + ":" + taskId;

    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    public async Task StopAsync(CancellationToken cancellationToken)
    {
        Task[] completions;
        lock (gate)
        {
            stopping = true;
            foreach (var run in active.Values) run.Cancellation.Cancel();
            completions = active.Values.Select(run => run.Completion).ToArray();
        }
        await Task.WhenAll(completions).WaitAsync(cancellationToken);
    }

    public void Dispose()
    {
        lock (gate)
        {
            stopping = true;
            foreach (var run in active.Values) run.Cancellation.Cancel();
        }
    }
}
