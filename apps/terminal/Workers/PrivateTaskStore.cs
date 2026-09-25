using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace JobPilot.Terminal.Workers;

public sealed class PrivateTaskStore
{
    private readonly string root;

    public PrivateTaskStore(WorkerOptions options)
    {
        root = Path.GetFullPath(options.PersonalRoot);
        for (var parent = new DirectoryInfo(root); parent is not null; parent = parent.Parent)
        {
            if (File.Exists(Path.Combine(parent.FullName, ".git")) || Directory.Exists(Path.Combine(parent.FullName, ".git")))
                throw new WorkerRequestException("JOBPILOT_PERSONAL_ROOT must be outside a Git checkout.", 503);
        }
    }

    public string TaskDirectory(string userId, string taskId) =>
        Path.Combine(root, "runtime", "tasks", Hash(userId), Guid.Parse(taskId).ToString("D"));

    internal StoredAgentTask? Read(string userId, string taskId)
    {
        var path = Path.Combine(TaskDirectory(userId, taskId), "state.json");
        if (!File.Exists(path)) return null;
        return JsonSerializer.Deserialize(File.ReadAllText(path), WorkerJsonContext.Default.StoredAgentTask);
    }

    internal void Write(string userId, StoredAgentTask task)
    {
        var directory = TaskDirectory(userId, task.Request.TaskId);
        WritePrivate(Path.Combine(directory, "state.json"), JsonSerializer.Serialize(task, WorkerJsonContext.Default.StoredAgentTask));
    }

    internal FileStream AcquireSlot(string userId, string role)
    {
        var directory = Path.Combine(root, "runtime", "tasks", Hash(userId));
        EnsureDirectory(directory);
        try
        {
            var options = new FileStreamOptions
            {
                Mode = FileMode.OpenOrCreate, Access = FileAccess.ReadWrite, Share = FileShare.None,
            };
            if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
            return new FileStream(Path.Combine(directory, role + ".lock"), options);
        }
        catch (IOException)
        {
            throw new WorkerRequestException($"This user's {role} slot is already active.", 409);
        }
    }

    internal static string Hash(string value) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    internal static void EnsureDirectory(string directory)
    {
        Directory.CreateDirectory(directory);
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(directory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0)
            throw new WorkerRequestException("Private task directories cannot be symbolic links.", 503);
    }

    internal static FileStream CreatePrivate(string path)
    {
        EnsureDirectory(Path.GetDirectoryName(path)!);
        var options = new FileStreamOptions
        {
            Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.Read,
        };
        if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        return new FileStream(path, options);
    }

    internal static void WritePrivate(string path, string text)
    {
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var stream = CreatePrivate(temporary))
            {
                stream.Write(Encoding.UTF8.GetBytes(text));
                stream.Flush(true);
            }
            File.Move(temporary, path, true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }
}
