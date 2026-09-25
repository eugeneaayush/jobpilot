using System.Diagnostics;
using JobPilot.Terminal.Common;

namespace JobPilot.Terminal.Workers;

public sealed class WorkerProviderCatalog
{
    private readonly Lazy<Task<WorkerProviderCapability[]>> versions = new(() => Task.WhenAll(ReadAsync("codex"), ReadAsync("claude")));
    public Task<WorkerProviderCapability[]> GetAsync() => versions.Value;

    private static async Task<WorkerProviderCapability> ReadAsync(string provider)
    {
        var executable = ExecutablePath.Find(provider);
        if (executable is null) return new(provider, false, null);
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo(executable)
            {
                UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true,
                CreateNoWindow = true, ArgumentList = { "--version" },
            },
        };
        try
        {
            process.Start();
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            var buffer = new char[256];
            var count = await process.StandardOutput.ReadAsync(buffer.AsMemory(), timeout.Token);
            await process.WaitForExitAsync(timeout.Token);
            var value = new string(buffer, 0, count).Trim();
            if (process.ExitCode != 0 || value.Any(c => char.IsControl(c))) return new(provider, true, null);
            return new(provider, true, value);
        }
        catch (Exception)
        {
            try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
            return new(provider, true, null);
        }
    }
}
