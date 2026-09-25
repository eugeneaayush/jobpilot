using System.Diagnostics;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace JobPilot.Terminal.Workers;

public sealed record WorkerBrowserScope(string PersonalRoot, string UserId, string TaskId, string AttemptId,
    string LeaseOwner, long LeaseGeneration, Uri ApiOrigin, string Bearer, DateTimeOffset CreatedAt);

internal static class WorkerBrowserCleanup
{
    internal static async Task TryCleanupAsync(WorkerBrowserScope scope)
    {
        using var handler = new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false };
        using var http = new HttpClient(handler);
        await TryCleanupAsync(scope, http, ProcessAlive, ProfileIdleAsync);
    }

    internal static async Task TryCleanupAsync(WorkerBrowserScope scope, HttpClient http,
        Func<int, bool?> processAlive, Func<string, CancellationToken, Task<bool>> profileIdle)
    {
        try
        {
            if ((!OperatingSystem.IsMacOS() && !OperatingSystem.IsLinux())
                || !Guid.TryParseExact(scope.UserId, "D", out _) || !Guid.TryParseExact(scope.TaskId, "D", out _)
                || !Guid.TryParseExact(scope.AttemptId, "D", out _) || !Path.IsPathFullyQualified(scope.PersonalRoot)
                || scope.LeaseGeneration < 1 || string.IsNullOrEmpty(scope.LeaseOwner)
                || scope.ApiOrigin.Scheme is not ("http" or "https")
                || scope.ApiOrigin.Host is not ("localhost" or "127.0.0.1" or "[::1]")
                || scope.ApiOrigin.UserInfo.Length > 0 || scope.ApiOrigin.AbsolutePath != "/"
                || scope.ApiOrigin.Query.Length > 0 || scope.ApiOrigin.Fragment.Length > 0)
                return;
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            var ct = deadline.Token;
            var root = Path.GetFullPath(scope.PersonalRoot);
            var user = Path.Combine(root, "users", scope.UserId);
            var ownerPath = Path.Combine(user, "browser.lock", "owner.json");
            var lockPath = Path.GetDirectoryName(ownerPath)!;
            var profile = Path.Combine(user, "browser-profile");
            if (!SafeDirectory(root) || !SafeDirectory(Path.Combine(root, "users")) || !SafeDirectory(user)
                || !SafeDirectory(lockPath) || !SafeFile(ownerPath)
                || new FileInfo(ownerPath).Length > 4096
                || File.GetLastWriteTimeUtc(ownerPath) < scope.CreatedAt.UtcDateTime.AddSeconds(-1)) return;
            var ownerBytes = await File.ReadAllBytesAsync(ownerPath, ct);
            using var owner = JsonDocument.Parse(ownerBytes);
            var value = owner.RootElement;
            if (value.TryGetProperty("handoffId", out _)
                || value.GetProperty("attemptId").GetString() != scope.AttemptId
                || value.GetProperty("leaseOwner").GetString() != scope.LeaseOwner
                || !value.GetProperty("pid").TryGetInt32(out var pid) || pid <= 1
                || !Guid.TryParse(value.GetProperty("nonce").GetString(), out _)
                || processAlive(pid) != false || !ProfileHasNoLock(profile)) return;
            var state = await PreSubmissionStateAsync(scope, http, ct);
            if (state is null || !await profileIdle(profile, ct)) return;

            var archives = Path.Combine(user, "browser-lock-quarantine");
            if (!EnsurePrivateDirectory(archives)) return;
            var archive = Path.Combine(archives, scope.TaskId + "-" + Guid.NewGuid().ToString("N"));
            if (!EnsurePrivateDirectory(archive)) return;
            var auditPath = Path.Combine(archive, "audit.json");
            WriteAudit(auditPath, scope, pid, state, ownerBytes, "verified_dead_owner");
            // Recheck after filesystem/API awaits; never move a replaced lock or live profile.
            if (!SafeDirectory(lockPath) || !SafeFile(ownerPath)) return;
            var currentOwnerBytes = await File.ReadAllBytesAsync(ownerPath, ct);
            if (!ownerBytes.AsSpan().SequenceEqual(currentOwnerBytes)
                || processAlive(pid) != false || !ProfileHasNoLock(profile)
                || !await profileIdle(profile, ct) || await PreSubmissionStateAsync(scope, http, ct) != state) return;
            ct.ThrowIfCancellationRequested();
            Directory.Move(lockPath, Path.Combine(archive, "browser.lock"));
            WriteAudit(auditPath, scope, pid, state, ownerBytes, "quarantined");
        }
        catch (Exception)
        {
            // Ambiguous cleanup leaves the lock in place and must not replace the task outcome.
        }
    }

    private static bool SafeDirectory(string path) => Directory.Exists(path)
        && (File.GetAttributes(path) & FileAttributes.ReparsePoint) == 0;
    private static bool SafeFile(string path) => File.Exists(path)
        && (File.GetAttributes(path) & (FileAttributes.ReparsePoint | FileAttributes.Directory)) == 0;
    private static bool EntryExists(string path) => File.Exists(path) || Directory.Exists(path)
        || new FileInfo(path).LinkTarget is not null || new DirectoryInfo(path).LinkTarget is not null;
    private static bool ProfileHasNoLock(string profile)
    {
        if (EntryExists(profile) && !SafeDirectory(profile)) return false;
        return new[] { "SingletonLock", "SingletonSocket", "SingletonCookie", "lockfile" }
            .All(name => !EntryExists(Path.Combine(profile, name)));
    }
    private static bool EnsurePrivateDirectory(string path)
    {
        if (EntryExists(path) && !SafeDirectory(path)) return false;
        PrivateTaskStore.EnsureDirectory(path);
        return SafeDirectory(path);
    }

    private static async Task<string?> PreSubmissionStateAsync(WorkerBrowserScope scope, HttpClient http, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(scope.ApiOrigin, "/api/personal/attempts/" + scope.AttemptId));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", scope.Bearer);
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!response.IsSuccessStatusCode || response.Content.Headers.ContentLength > 2_000_000) return null;
        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var buffer = new MemoryStream();
        var bytes = new byte[8192];
        int count;
        while ((count = await stream.ReadAsync(bytes, ct)) > 0)
        {
            if (buffer.Length + count > 2_000_000) return null;
            buffer.Write(bytes, 0, count);
        }
        using var doc = JsonDocument.Parse(buffer.ToArray());
        var value = doc.RootElement;
        if (value.GetProperty("id").GetString() != scope.AttemptId || value.GetProperty("userId").GetString() != scope.UserId
            || !value.TryGetProperty("submitAt", out var submitted) || submitted.ValueKind != JsonValueKind.Null
            || value.GetProperty("leaseOwner").GetString() != scope.LeaseOwner) return null;
        var state = value.GetProperty("state").GetString();
        var generation = value.GetProperty("leaseGeneration").GetInt64();
        if (state is "preparing" or "prepared") return generation == scope.LeaseGeneration ? state : null;
        if (state is "blocked" or "failed" or "cancelled" or "previewed")
            return generation == scope.LeaseGeneration + 1 ? state : null;
        return null;
    }

    private static bool? ProcessAlive(int pid)
    {
        try { using var process = Process.GetProcessById(pid); return !process.HasExited; }
        catch (ArgumentException) { return false; }
        catch (Exception) { return null; }
    }

    private static async Task<bool> ProfileIdleAsync(string profile, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(2));
        using var process = new Process { StartInfo = new ProcessStartInfo("/bin/ps")
        {
            UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true,
            ArgumentList = { "-axo", "pid=,args=" },
        } };
        try
        {
            if (!process.Start()) return false;
            var errors = process.StandardError.ReadToEndAsync(timeout.Token);
            var scanned = 0;
            string? line;
            while ((line = await process.StandardOutput.ReadLineAsync(timeout.Token)) is not null)
            {
                scanned += line.Length;
                if (scanned > 2_000_000 || line.Contains(profile, StringComparison.Ordinal)) return false;
            }
            await process.WaitForExitAsync(timeout.Token);
            return process.ExitCode == 0 && string.IsNullOrWhiteSpace(await errors);
        }
        finally
        {
            try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
        }
    }

    private static void WriteAudit(string path, WorkerBrowserScope scope, int pid, string state, byte[] owner, string outcome)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteNumber("schemaVersion", 1);
            writer.WriteString("taskId", scope.TaskId);
            writer.WriteString("attemptId", scope.AttemptId);
            writer.WriteString("capturedAt", DateTimeOffset.UtcNow);
            writer.WriteString("outcome", outcome);
            writer.WriteString("attemptState", state);
            writer.WriteNumber("deadOwnerPid", pid);
            writer.WriteString("ownerSha256", Convert.ToHexStringLower(SHA256.HashData(owner)));
            writer.WriteEndObject();
        }
        PrivateTaskStore.WritePrivate(path, Encoding.UTF8.GetString(buffer.ToArray()));
    }
}
