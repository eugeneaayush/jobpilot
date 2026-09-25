using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace JobPilot.Terminal.Workers;

internal sealed class CodexSupervisorRpc : IAsyncDisposable
{
    private readonly Process process;
    private readonly WorkerOptions options;
    private readonly Queue<JsonObject> notifications = new();
    private readonly StringBuilder buffered = new();
    private readonly CancellationTokenSource stopped = new();
    private readonly Task stderr;
    private int sequence;
    private int bytes;

    private CodexSupervisorRpc(Process process, WorkerOptions options)
    {
        this.process = process;
        this.options = options;
        stderr = DrainErrorsAsync();
    }

    internal static Task<CodexSupervisorRpc> StartAsync(string executable, string directory, WorkerOptions options, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (!CodexSupervisorPolicy.PlatformSupported) throw new WorkerRequestException(CodexSupervisorPolicy.Unavailable, 503);
        var start = new ProcessStartInfo("/usr/bin/sandbox-exec")
        {
            WorkingDirectory = directory, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
        };
        var codexHome = Environment.GetEnvironmentVariable("CODEX_HOME")
            ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex");
        start.ArgumentList.Add("-p");
        start.ArgumentList.Add(CodexSupervisorPolicy.SandboxProfile(options.PersonalRoot, codexHome, directory));
        start.ArgumentList.Add(executable);
        foreach (var arg in CodexSupervisorPolicy.Arguments()) start.ArgumentList.Add(arg);
        ProcessAgentAdapter.SanitizeEnvironment(start.Environment);
        var process = new Process { StartInfo = start };
        try
        {
            if (!process.Start()) throw new IOException("Could not launch Codex app-server.");
            return Task.FromResult(new CodexSupervisorRpc(process, options));
        }
        catch { process.Dispose(); throw; }
    }

    internal async Task<JsonObject> RequestAsync(string method, JsonObject parameters, CancellationToken ct)
    {
        var id = ++sequence;
        await SendAsync(new JsonObject { ["id"] = id, ["method"] = method, ["params"] = parameters }, ct);
        while (true)
        {
            var message = await ReadAsync(ct);
            if (message["id"]?.GetValue<int>() == id)
            {
                if (message.ContainsKey("error")) throw new WorkerRequestException($"Codex rejected isolated {method} (code {message["error"]?["code"]?.GetValue<int>()}).", 503);
                return message["result"]?.DeepClone() as JsonObject ?? throw new InvalidDataException("Invalid Codex response.");
            }
            if (notifications.Count >= 256) throw new InvalidDataException("Too many pending supervisor events.");
            notifications.Enqueue(message);
        }
    }

    internal Task NotifyAsync(string method, CancellationToken ct) => SendAsync(new JsonObject { ["method"] = method }, ct);

    internal async Task<JsonObject> NextNotificationAsync(CancellationToken ct) =>
        notifications.Count > 0 ? notifications.Dequeue() : await ReadAsync(ct);

    private async Task SendAsync(JsonObject message, CancellationToken ct)
    {
        await process.StandardInput.WriteLineAsync(message.ToJsonString().AsMemory(), ct);
        await process.StandardInput.FlushAsync(ct);
    }

    private async Task<JsonObject> ReadAsync(CancellationToken ct)
    {
        var buffer = new char[4096];
        while (true)
        {
            var text = buffered.ToString();
            var end = text.IndexOf('\n');
            if (end >= 0)
            {
                buffered.Remove(0, end + 1);
                var message = JsonNode.Parse(text[..end]) as JsonObject ?? throw new InvalidDataException("Invalid Codex event.");
                if (message.ContainsKey("id") && message.ContainsKey("method"))
                {
                    await SendAsync(new JsonObject
                    {
                        ["id"] = message["id"]!.DeepClone(),
                        ["error"] = new JsonObject { ["code"] = -32601, ["message"] = "Supervisor tools and approvals are disabled." },
                    }, ct);
                    throw new InvalidDataException("Supervisor requested a client tool or approval.");
                }
                return message;
            }
            var count = await process.StandardOutput.ReadAsync(buffer.AsMemory(), ct);
            if (count == 0) throw new IOException("Codex app-server closed its stream.");
            Count(buffer.AsSpan(0, count));
            buffered.Append(buffer, 0, count);
            if (buffered.Length > 64 * 1024) throw new InvalidDataException("Codex event exceeded its bound.");
            if (stderr.IsFaulted) await stderr;
        }
    }

    private async Task DrainErrorsAsync()
    {
        var buffer = new char[2048];
        int count;
        while ((count = await process.StandardError.ReadAsync(buffer.AsMemory(), stopped.Token)) > 0)
            Count(buffer.AsSpan(0, count));
    }

    private void Count(ReadOnlySpan<char> value)
    {
        if (Interlocked.Add(ref bytes, Encoding.UTF8.GetByteCount(value)) > options.MaxOutputBytes)
        {
            ProcessAgentAdapter.KillTree(process);
            throw new InvalidDataException("Codex output exceeded its bound.");
        }
    }

    public async ValueTask DisposeAsync()
    {
        await ProcessAgentAdapter.TerminateAsync(process, options.CancelGrace);
        await stopped.CancelAsync();
        try { await stderr; } catch (OperationCanceledException) { } catch (IOException) { }
        process.Dispose();
        stopped.Dispose();
    }
}
