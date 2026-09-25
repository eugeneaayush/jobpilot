using System.Text.Json;

namespace JobPilot.Terminal.Workers;

public sealed class WorkerHandoffService(WorkerOptions options, PrivateTaskStore store, IWorkerHandoffApi api,
    IWorkerHandoffBrowserFactory browsers) : IHostedService
{
    private sealed class Session(WorkerIdentity identity, WorkerHandoffSnapshot snapshot, IWorkerHandoffBrowser browser, FileStream slot)
    {
        public WorkerIdentity Identity { get; } = identity;
        public WorkerHandoffSnapshot Snapshot { get; set; } = snapshot;
        public IWorkerHandoffBrowser Browser { get; } = browser;
        public FileStream Slot { get; } = slot;
        public DateTimeOffset Deadline { get; set; }
    }
    private readonly SemaphoreSlim gate = new(1);
    private readonly Dictionary<string, Session> sessions = [];
    private readonly CancellationTokenSource stopping = new();
    private Task monitor = Task.CompletedTask;

    public async Task<WorkerHandoffSnapshot?> GetAsync(WorkerIdentity identity, string attemptId, CancellationToken ct)
    {
        var state = await api.GetAsync(identity, WorkerHandoffValidation.Id(attemptId), ct);
        if (state is null) return null;
        state = WorkerHandoffValidation.Check(state, attemptId);
        await gate.WaitAsync(ct);
        try
        {
            var open = sessions.TryGetValue(identity.UserId, out var session) && session.Snapshot.HandoffId == state.HandoffId && session.Browser.IsRunning;
            return Save(identity.UserId, state with { BrowserOpen = open }, "status", open ? "Local handoff browser is open." : "Handoff is available in the private dashboard.");
        }
        finally { gate.Release(); }
    }

    public async Task<WorkerHandoffSnapshot> OpenAsync(WorkerIdentity identity, string attemptId, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            if (stopping.IsCancellationRequested) throw new WorkerRequestException("The handoff host is stopping.", 503);
            var state = await RequireAsync(identity, attemptId, ct);
            if (sessions.TryGetValue(identity.UserId, out var existing))
            {
                if (existing.Snapshot.HandoffId == state.HandoffId && existing.Browser.IsRunning)
                {
                    try { WorkerHandoffValidation.SameScope(existing.Snapshot, state); }
                    catch { await RemoveAsync(existing); throw; }
                    return existing.Snapshot;
                }
                throw new WorkerRequestException("This user's exclusive browser profile is already in use.", 409);
            }
            if (state.Status == "resolved") throw new WorkerRequestException("This browser handoff is already finished.", 409);
            var slot = store.AcquireSlot(identity.UserId, "worker");
            IWorkerHandoffBrowser? browser = null;
            try
            {
                state = await api.TransitionAsync(identity, state, "open", ct);
                if (state.LeaseExpiresAt <= DateTimeOffset.UtcNow) throw new WorkerRequestException("Browser handoff lease expired.", 409);
                var directory = DirectoryFor(identity.UserId, attemptId);
                PrivateTaskStore.EnsureDirectory(directory);
                browser = browsers.Create(identity, state, directory);
                await browser.OpenAsync(ct);
                var session = new Session(identity, Save(identity.UserId, state with { Status = "open", BrowserOpen = true }, "open", "User-controlled browser opened; automatic submission is disabled."), browser, slot)
                { Deadline = DateTimeOffset.UtcNow + options.Timeout };
                sessions.Add(identity.UserId, session);
                return session.Snapshot;
            }
            catch
            {
                if (browser is not null) await browser.DisposeAsync();
                slot.Dispose();
                Save(identity.UserId, state with { BrowserOpen = false }, "blocked", "Local browser did not open; the affected job remains parked.");
                throw;
            }
        }
        finally { gate.Release(); }
    }

    public async Task<WorkerHandoffSnapshot> ResumeAsync(WorkerIdentity identity, string attemptId, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            var state = await RequireAsync(identity, attemptId, ct);
            if (!sessions.TryGetValue(identity.UserId, out var session) || session.Snapshot.HandoffId != state.HandoffId || !session.Browser.IsRunning)
                throw new WorkerRequestException("Open the local handoff browser before resuming this job.", 409);
            WorkerHandoffValidation.SameScope(session.Snapshot, state);
            if (state.LeaseExpiresAt <= DateTimeOffset.UtcNow) throw new WorkerRequestException("Browser handoff lease expired; reopen from the dashboard.", 409);
            var proof = await session.Browser.ResumeAsync(ct);
            if (proof is null)
                return session.Snapshot = Save(identity.UserId, state with { BrowserOpen = true }, "blocked", "The browser still requires user handling. No application was submitted.");
            // Release the exclusive profile before the API makes preparation available again.
            await RemoveAsync(session);
            state = await api.TransitionAsync(identity, state, "resume", ct, proof);
            return Save(identity.UserId, state with { BrowserOpen = false }, "resolved", "Browser handoff verified; fresh preparation is required before any submission.");
        }
        finally { gate.Release(); }
    }

    public async Task<WorkerHandoffSnapshot> CancelAsync(WorkerIdentity identity, string attemptId, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            var state = await RequireAsync(identity, attemptId, ct);
            try { state = await api.TransitionAsync(identity, state, "cancel", ct); }
            finally
            {
                if (sessions.TryGetValue(identity.UserId, out var session) && session.Snapshot.HandoffId == state.HandoffId) await RemoveAsync(session);
            }
            return Save(identity.UserId, state with { BrowserOpen = false }, "cancelled", "Browser handoff cancelled; the affected job remains parked.");
        }
        finally { gate.Release(); }
    }

    private async Task<WorkerHandoffSnapshot> RequireAsync(WorkerIdentity identity, string attemptId, CancellationToken ct)
    {
        attemptId = WorkerHandoffValidation.Id(attemptId);
        var state = await api.GetAsync(identity, attemptId, ct) ?? throw new WorkerRequestException("Browser handoff was not found.", 404);
        return WorkerHandoffValidation.Check(state, attemptId);
    }

    private async Task RemoveAsync(Session session)
    {
        try { await session.Browser.DisposeAsync(); }
        finally { session.Slot.Dispose(); sessions.Remove(session.Identity.UserId); }
    }

    private string DirectoryFor(string userId, string attemptId) =>
        Path.Combine(Path.GetFullPath(options.PersonalRoot), "runtime", "handoffs", PrivateTaskStore.Hash(userId), WorkerHandoffValidation.Id(attemptId));

    private WorkerHandoffSnapshot Save(string userId, WorkerHandoffSnapshot state, string type, string message)
    {
        var path = Path.Combine(DirectoryFor(userId, state.AttemptId), "state.json");
        WorkerHandoffSnapshot? previous = null;
        if (File.Exists(path)) previous = JsonSerializer.Deserialize(File.ReadAllText(path), WorkerJsonContext.Default.WorkerHandoffSnapshot);
        var events = previous?.HandoffId == state.HandoffId ? previous.Events : [];
        var now = DateTimeOffset.UtcNow;
        state = state with { UpdatedAt = now, Events = events.Append(new((events.LastOrDefault()?.Sequence ?? 0) + 1, now, type, message)).TakeLast(50).ToArray() };
        PrivateTaskStore.WritePrivate(path, JsonSerializer.Serialize(state, WorkerJsonContext.Default.WorkerHandoffSnapshot));
        return state;
    }

    private async Task MonitorAsync()
    {
        using var timer = new PeriodicTimer(options.HeartbeatInterval);
        try
        {
            while (await timer.WaitForNextTickAsync(stopping.Token))
            {
                await gate.WaitAsync(stopping.Token);
                try
                {
                    foreach (var session in sessions.Values.ToArray())
                    {
                        try
                        {
                            if (!session.Browser.IsRunning || DateTimeOffset.UtcNow >= session.Deadline) throw new IOException();
                            var state = await api.TransitionAsync(session.Identity, session.Snapshot, "heartbeat", stopping.Token);
                            WorkerHandoffValidation.SameScope(session.Snapshot, state);
                            if (state.LeaseExpiresAt <= DateTimeOffset.UtcNow || state.Status is not ("open" or "opening")) throw new IOException();
                            session.Snapshot = Save(session.Identity.UserId, state with { BrowserOpen = true }, "heartbeat", "Exclusive handoff lease renewed.");
                        }
                        catch (Exception)
                        {
                            await RemoveAsync(session);
                            Save(session.Identity.UserId, session.Snapshot with { Status = "expired", BrowserOpen = false }, "expired", "Browser handoff stopped; reopen from the dashboard before continuing.");
                        }
                    }
                }
                finally { gate.Release(); }
            }
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
    }

    public Task StartAsync(CancellationToken ct) { monitor = MonitorAsync(); return Task.CompletedTask; }
    public async Task StopAsync(CancellationToken ct)
    {
        await stopping.CancelAsync();
        await monitor.WaitAsync(ct);
        await gate.WaitAsync(ct);
        try
        {
            foreach (var session in sessions.Values.ToArray())
            {
                await RemoveAsync(session);
                Save(session.Identity.UserId, session.Snapshot with { BrowserOpen = false }, "closed", "Host stopped; handoff must be reopened explicitly.");
            }
        }
        finally { gate.Release(); }
    }
}
