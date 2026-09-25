using System.Diagnostics;
using System.Text;
using System.Text.Json;
using JobPilot.Terminal.Common;

namespace JobPilot.Terminal.Workers;

public sealed class WorkerHandoffBrowserFactory(WorkerOptions options) : IWorkerHandoffBrowserFactory
{
    public IWorkerHandoffBrowser Create(WorkerIdentity identity, WorkerHandoffSnapshot handoff, string workingDirectory)
    {
        if (options.McpConfigPath is null || !File.Exists(options.McpConfigPath))
            throw new WorkerRequestException("The local browser broker is not configured.", 503);
        using var document = JsonDocument.Parse(File.ReadAllText(options.McpConfigPath));
        var server = document.RootElement.GetProperty("mcpServers").GetProperty("jobpilot");
        var command = server.GetProperty("command").GetString();
        var args = server.GetProperty("args");
        if (command is null || Path.GetFileName(command) is not ("bun" or "bun.exe") || args.GetArrayLength() != 1
            || args[0].GetString() is not { } script || !Path.IsPathFullyQualified(script)
            || Path.GetFileName(script) != "personal-browser.ts" || !File.Exists(script))
            throw new WorkerRequestException("The local browser broker must use the fixed personal-browser script.", 503);
        var executable = ExecutablePath.Find(command) ?? throw new WorkerRequestException("The local Bun runtime is unavailable.", 503);
        var start = new ProcessStartInfo(executable)
        {
            WorkingDirectory = workingDirectory, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
        };
        start.ArgumentList.Add(script);
        start.ArgumentList.Add("--handoff");
        foreach (var key in start.Environment.Keys.ToArray())
            if (key is not ("PATH" or "HOME" or "USERPROFILE" or "TMPDIR" or "TEMP" or "TMP" or "SystemRoot" or "DISPLAY" or "WAYLAND_DISPLAY" or "XDG_RUNTIME_DIR"))
                start.Environment.Remove(key);
        start.Environment["JOBPILOT_API"] = options.PrivateApiOrigin().ToString().TrimEnd('/');
        start.Environment["JOBPILOT_API_TOKEN"] = identity.Bearer;
        start.Environment["JOBPILOT_ATTEMPT_ID"] = handoff.AttemptId;
        start.Environment["JOBPILOT_LEASE_OWNER"] = handoff.LeaseOwner;
        start.Environment["JOBPILOT_LEASE_GENERATION"] = handoff.LeaseGeneration.ToString(System.Globalization.CultureInfo.InvariantCulture);
        start.Environment["JOBPILOT_PERSONAL_ROOT"] = Path.GetFullPath(options.PersonalRoot);
        start.Environment["JOBPILOT_HANDOFF_ID"] = handoff.HandoffId;
        return new WorkerHandoffBrowser(start, options.CancelGrace);
    }
}

internal sealed class WorkerHandoffBrowser(ProcessStartInfo start, TimeSpan grace) : IWorkerHandoffBrowser
{
    private readonly Process process = new() { StartInfo = start };
    private Task stderr = Task.CompletedTask;
    private bool started;
    private int bytes;
    public bool IsRunning => started && !process.HasExited;

    public async Task OpenAsync(CancellationToken ct)
    {
        try
        {
            started = process.Start();
            if (!started) throw new IOException();
            stderr = DrainErrorsAsync();
            var response = await ExchangeAsync("open", ct);
            if (response.Type != "ready") throw new WorkerRequestException("The local browser could not open this handoff; inspect its parked status.", 409);
        }
        catch (System.ComponentModel.Win32Exception)
        {
            throw new WorkerRequestException("The local browser runtime could not start.", 503);
        }
    }

    public async Task<string?> ResumeAsync(CancellationToken ct)
    {
        var response = await ExchangeAsync("resume", ct);
        return response.Type == "resolved" ? response.ProofHash : null;
    }

    public async Task CloseAsync(CancellationToken ct)
    {
        if (!IsRunning) return;
        try { await process.StandardInput.WriteLineAsync("{\"type\":\"cancel\"}".AsMemory(), ct); await process.StandardInput.FlushAsync(ct); }
        catch (IOException) { }
        await ProcessAgentAdapter.TerminateAsync(process, grace);
    }

    private async Task<(string Type, string? ProofHash)> ExchangeAsync(string command, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(20));
        await process.StandardInput.WriteLineAsync(("{\"type\":\"" + command + "\"}").AsMemory(), timeout.Token);
        await process.StandardInput.FlushAsync(timeout.Token);
        var text = new StringBuilder();
        var buffer = new char[1];
        while (await process.StandardOutput.ReadAsync(buffer.AsMemory(), timeout.Token) > 0)
        {
            if (Interlocked.Add(ref bytes, Encoding.UTF8.GetByteCount(buffer)) > 64 * 1024 || text.Length >= 2048)
                throw new InvalidDataException("Handoff browser exceeded its bounded protocol.");
            if (buffer[0] == '\n') break;
            text.Append(buffer[0]);
        }
        using var document = JsonDocument.Parse(text.ToString());
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object || root.EnumerateObject().Any(property => property.Name is not ("type" or "proofHash"))
            || !root.TryGetProperty("type", out var kind) || kind.ValueKind != JsonValueKind.String
            || kind.GetString() is not ("ready" or "resolved" or "blocked" or "closed"))
            throw new InvalidDataException("Handoff browser returned an invalid protocol event.");
        var proof = root.TryGetProperty("proofHash", out var hash) && hash.ValueKind == JsonValueKind.String ? hash.GetString() : null;
        if (kind.GetString() == "resolved" && (proof is null || proof.Length != 64 || proof.Any(c => !char.IsAsciiHexDigitLower(c))))
            throw new InvalidDataException("Handoff browser did not provide a bounded verification proof.");
        return (kind.GetString()!, proof);
    }

    private async Task DrainErrorsAsync()
    {
        var buffer = new char[1024];
        int count;
        while ((count = await process.StandardError.ReadAsync(buffer)) > 0)
            if (Interlocked.Add(ref bytes, Encoding.UTF8.GetByteCount(buffer.AsSpan(0, count))) > 64 * 1024)
            {
                ProcessAgentAdapter.KillTree(process);
                return;
            }
    }

    public async ValueTask DisposeAsync()
    {
        if (started) await CloseAsync(CancellationToken.None);
        ProcessAgentAdapter.KillTree(process);
        try { await stderr; } catch (IOException) { }
        process.Dispose();
    }
}
