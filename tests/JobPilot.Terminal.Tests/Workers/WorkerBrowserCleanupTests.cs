using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using JobPilot.Terminal.Workers;
using Xunit;

namespace JobPilot.Terminal.Tests;

public sealed class WorkerBrowserCleanupTests
{
    private sealed class Fixture : IDisposable
    {
        private readonly TempDir temp = new();
        public WorkerBrowserScope Scope { get; }
        public string UserPath { get; }
        public string LockPath => Path.Combine(UserPath, "browser.lock");
        public string OwnerPath => Path.Combine(LockPath, "owner.json");
        public string ProfilePath => Path.Combine(UserPath, "browser-profile");
        public JsonObject Owner { get; }
        public JsonObject Attempt { get; }

        public Fixture()
        {
            Scope = new(temp.Root, Guid.NewGuid().ToString("D"), Guid.NewGuid().ToString("D"),
                Guid.NewGuid().ToString("D"), "synthetic-lease-owner", 3,
                new("http://127.0.0.1:4101"), "synthetic-secret-bearer", DateTimeOffset.UtcNow);
            UserPath = Path.Combine(temp.Root, "users", Scope.UserId);
            Directory.CreateDirectory(LockPath);
            Directory.CreateDirectory(ProfilePath);
            Owner = new()
            {
                ["attemptId"] = Scope.AttemptId, ["leaseOwner"] = Scope.LeaseOwner,
                ["pid"] = 12345, ["nonce"] = Guid.NewGuid().ToString("D"),
            };
            Attempt = new()
            {
                ["id"] = Scope.AttemptId, ["userId"] = Scope.UserId,
                ["leaseOwner"] = Scope.LeaseOwner, ["leaseGeneration"] = Scope.LeaseGeneration,
                ["submitAt"] = null, ["state"] = "preparing",
            };
            SaveOwner();
        }

        public void SaveOwner() => File.WriteAllText(OwnerPath, Owner.ToJsonString());
        public Task RunAsync(Func<int, bool?>? alive = null,
            Func<string, CancellationToken, Task<bool>>? idle = null,
            Func<HttpRequestMessage, int, HttpResponseMessage>? response = null) => RunCoreAsync(alive, idle, response);

        private async Task RunCoreAsync(Func<int, bool?>? alive = null,
            Func<string, CancellationToken, Task<bool>>? idle = null,
            Func<HttpRequestMessage, int, HttpResponseMessage>? response = null)
        {
            using var http = new HttpClient(new Handler((request, call) =>
            {
                Assert.Equal(HttpMethod.Get, request.Method);
                Assert.Equal("/api/personal/attempts/" + Scope.AttemptId, request.RequestUri!.AbsolutePath);
                Assert.Equal(Scope.Bearer, request.Headers.Authorization!.Parameter);
                return response?.Invoke(request, call)
                    ?? new(HttpStatusCode.OK) { Content = new StringContent(Attempt.ToJsonString()) };
            }));
            await WorkerBrowserCleanup.TryCleanupAsync(Scope, http, alive ?? (_ => false),
                idle ?? ((_, _) => Task.FromResult(true)));
        }

        public void AssertHeld() => Assert.True(Directory.Exists(LockPath), "An ambiguous browser lock must remain held.");
        public void Dispose() => temp.Dispose();
    }

    private sealed class Handler(Func<HttpRequestMessage, int, HttpResponseMessage> response) : HttpMessageHandler
    {
        private int calls;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => Task.FromResult(response(request, ++calls));
    }

    [Theory]
    [InlineData("preparing", 3)]
    [InlineData("prepared", 3)]
    [InlineData("blocked", 4)]
    [InlineData("failed", 4)]
    [InlineData("cancelled", 4)]
    [InlineData("previewed", 4)]
    public async Task DeadOwnedPreSubmissionLockIsQuarantinedWithPrivateRedactedAudit(string state, int generation)
    {
        if (OperatingSystem.IsWindows()) return;
        using var fixture = new Fixture();
        fixture.Attempt["state"] = state;
        fixture.Attempt["leaseGeneration"] = generation;
        var original = File.ReadAllText(fixture.OwnerPath);
        await fixture.RunAsync();
        Assert.False(Directory.Exists(fixture.LockPath));
        var quarantine = Path.Combine(fixture.UserPath, "browser-lock-quarantine");
        var archive = Assert.Single(Directory.GetDirectories(quarantine));
        Assert.Equal(original, File.ReadAllText(Path.Combine(archive, "browser.lock", "owner.json")));
        var auditPath = Path.Combine(archive, "audit.json");
        var audit = File.ReadAllText(auditPath);
        using var doc = JsonDocument.Parse(audit);
        Assert.Equal("quarantined", doc.RootElement.GetProperty("outcome").GetString());
        Assert.Equal(fixture.Scope.AttemptId, doc.RootElement.GetProperty("attemptId").GetString());
        Assert.Equal(state, doc.RootElement.GetProperty("attemptState").GetString());
        Assert.Matches("^[0-9a-f]{64}$", doc.RootElement.GetProperty("ownerSha256").GetString()!);
        Assert.DoesNotContain(fixture.Scope.Bearer, audit);
        Assert.DoesNotContain(fixture.Scope.PersonalRoot, audit);
        Assert.DoesNotContain(fixture.Scope.LeaseOwner, audit);
        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(auditPath));
        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute, File.GetUnixFileMode(archive));
        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute, File.GetUnixFileMode(quarantine));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(null)]
    public async Task AliveOrUnknownOwnerIsNeverReleased(bool? alive)
    {
        using var fixture = new Fixture();
        await fixture.RunAsync(alive: _ => alive);
        fixture.AssertHeld();
    }

    [Fact]
    public async Task LiveProfileOrUnavailableProcessScanIsNeverReleased()
    {
        using var fixture = new Fixture();
        await fixture.RunAsync(idle: (_, _) => Task.FromResult(false));
        fixture.AssertHeld();
        await fixture.RunAsync(idle: (_, _) => throw new IOException("synthetic-private-scan-failure"));
        fixture.AssertHeld();
    }

    [Theory]
    [InlineData("attemptId")]
    [InlineData("leaseOwner")]
    [InlineData("nonce")]
    [InlineData("handoffId")]
    public async Task DifferentOwnerOrHandoffLockIsNeverReleased(string property)
    {
        using var fixture = new Fixture();
        fixture.Owner[property] = "different-synthetic-owner";
        fixture.SaveOwner();
        await fixture.RunAsync();
        fixture.AssertHeld();
    }

    [Theory]
    [InlineData("id", "wrong-attempt")]
    [InlineData("userId", "wrong-user")]
    [InlineData("leaseOwner", "wrong-owner")]
    [InlineData("state", "submitting")]
    [InlineData("state", "submitted")]
    [InlineData("state", "submission_uncertain")]
    [InlineData("submitAt", "2026-09-16T12:00:00Z")]
    public async Task DifferentApiScopeOrPossibleSubmissionIsNeverReleased(string property, string value)
    {
        using var fixture = new Fixture();
        fixture.Attempt[property] = value;
        await fixture.RunAsync();
        fixture.AssertHeld();
    }

    [Theory]
    [InlineData("preparing", 2)]
    [InlineData("prepared", 4)]
    [InlineData("blocked", 3)]
    [InlineData("cancelled", 5)]
    public async Task WrongLeaseGenerationIsNeverReleased(string state, int generation)
    {
        using var fixture = new Fixture();
        fixture.Attempt["state"] = state;
        fixture.Attempt["leaseGeneration"] = generation;
        await fixture.RunAsync();
        fixture.AssertHeld();
    }

    [Theory]
    [InlineData(401)]
    [InlineData(302)]
    [InlineData(503)]
    public async Task UnavailableApiIsNeverReleased(int status)
    {
        using var fixture = new Fixture();
        await fixture.RunAsync(response: (_, _) => new((HttpStatusCode)status));
        fixture.AssertHeld();
    }

    [Fact]
    public async Task ApiTransportFailureAndMalformedResponsePreserveLock()
    {
        using var fixture = new Fixture();
        await fixture.RunAsync(response: (_, _) => throw new HttpRequestException("synthetic-failure"));
        fixture.AssertHeld();
        await fixture.RunAsync(response: (_, _) => new(HttpStatusCode.OK) { Content = new StringContent("{}") });
        fixture.AssertHeld();
    }

    [Theory]
    [InlineData("SingletonLock")]
    [InlineData("SingletonSocket")]
    [InlineData("SingletonCookie")]
    [InlineData("lockfile")]
    public async Task ExistingBrowserLockIncludingDanglingSymlinkIsNeverReleased(string name)
    {
        if (OperatingSystem.IsWindows()) return;
        using var fixture = new Fixture();
        File.CreateSymbolicLink(Path.Combine(fixture.ProfilePath, name), "synthetic-missing-target");
        await fixture.RunAsync();
        fixture.AssertHeld();
    }

    [Theory]
    [InlineData("owner")]
    [InlineData("profile")]
    [InlineData("lock")]
    [InlineData("quarantine")]
    [InlineData("users")]
    public async Task SymlinkedPrivatePathsAreNeverFollowed(string entry)
    {
        if (OperatingSystem.IsWindows()) return;
        using var fixture = new Fixture();
        var path = entry switch
        {
            "owner" => fixture.OwnerPath,
            "profile" => fixture.ProfilePath,
            "lock" => fixture.LockPath,
            "quarantine" => Path.Combine(fixture.UserPath, "browser-lock-quarantine"),
            _ => Path.Combine(fixture.Scope.PersonalRoot, "users"),
        };
        var target = Path.Combine(fixture.Scope.PersonalRoot, "synthetic-link-target");
        if (entry == "owner")
        {
            File.Move(path, target);
            File.CreateSymbolicLink(path, target);
        }
        else
        {
            if (Directory.Exists(path)) Directory.Move(path, target);
            else Directory.CreateDirectory(target);
            Directory.CreateSymbolicLink(path, target);
        }
        await fixture.RunAsync();
        fixture.AssertHeld();
    }

    [Fact]
    public async Task LockPredatingThisTaskIsNeverReleased()
    {
        using var fixture = new Fixture();
        File.SetLastWriteTimeUtc(fixture.OwnerPath, fixture.Scope.CreatedAt.UtcDateTime.AddMinutes(-1));
        await fixture.RunAsync();
        fixture.AssertHeld();
    }

    [Fact]
    public async Task ReplacedLockAndApiTransitionDuringChecksAreNeverReleased()
    {
        using var fixture = new Fixture();
        await fixture.RunAsync(idle: (_, _) =>
        {
            fixture.Owner["nonce"] = Guid.NewGuid().ToString("D");
            fixture.SaveOwner();
            return Task.FromResult(true);
        });
        fixture.AssertHeld();
        await fixture.RunAsync(response: (_, call) =>
        {
            if (call == 2) fixture.Attempt["state"] = "submitting";
            return new(HttpStatusCode.OK) { Content = new StringContent(fixture.Attempt.ToJsonString()) };
        });
        fixture.AssertHeld();
    }
}
