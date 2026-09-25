using System.Diagnostics;
using System.Runtime.InteropServices;

namespace JobPilot.Terminal.Workers;

internal static partial class ProcessSignals
{
    internal readonly record struct ChildProcess(int Id, DateTime StartedAt);

    [LibraryImport("libc", EntryPoint = "kill", SetLastError = true)]
    private static partial int Kill(int pid, int signal);
    internal static void Interrupt(int pid) => Kill(pid, 2);

    // A parent can exit on SIGINT before Kill(entireProcessTree) can discover its surviving children.
    internal static async Task<ChildProcess[]> DescendantsAsync(int rootPid)
    {
        if (OperatingSystem.IsWindows()) return [];
        using var command = new Process
        {
            StartInfo = new ProcessStartInfo("/bin/ps")
            {
                UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true,
                ArgumentList = { "-axo", "pid=,ppid=" },
            },
        };
        try
        {
            command.Start();
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            var output = await command.StandardOutput.ReadToEndAsync(timeout.Token);
            await command.WaitForExitAsync(timeout.Token);
            var parents = new Dictionary<int, int>();
            foreach (var line in output.Split('\n'))
            {
                var fields = line.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
                if (fields.Length == 2 && int.TryParse(fields[0], out var id) && int.TryParse(fields[1], out var parent)) parents[id] = parent;
            }
            var ids = new HashSet<int> { rootPid };
            var changed = true;
            while (changed)
            {
                changed = false;
                foreach (var (id, parent) in parents)
                    if (ids.Contains(parent) && ids.Add(id)) changed = true;
            }
            List<ChildProcess> children = [];
            foreach (var id in ids.Where(id => id != rootPid))
            {
                try
                {
                    using var child = Process.GetProcessById(id);
                    children.Add(new(id, child.StartTime));
                }
                catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception) { }
            }
            return [.. children];
        }
        catch (Exception)
        {
            try { if (!command.HasExited) command.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
            return [];
        }
    }

    internal static void KillSurvivors(IEnumerable<ChildProcess> children)
    {
        foreach (var saved in children)
        {
            try
            {
                using var child = Process.GetProcessById(saved.Id);
                if (!child.HasExited && child.StartTime == saved.StartedAt) child.Kill(entireProcessTree: true);
            }
            catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception) { }
        }
    }
}
