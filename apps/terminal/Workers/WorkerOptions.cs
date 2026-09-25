namespace JobPilot.Terminal.Workers;

public sealed class WorkerOptions
{
    public string PersonalRoot { get; init; } = Environment.GetEnvironmentVariable("JOBPILOT_PERSONAL_ROOT")
        ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Library", "Application Support", "JobPilotPersonal");
    public string ApiUrl { get; init; } = Environment.GetEnvironmentVariable("JOBPILOT_API") ?? "http://127.0.0.1:4101";
    public string? McpConfigPath { get; init; } = Environment.GetEnvironmentVariable("JOBPILOT_WORKER_MCP_CONFIG");
    public string ClaudeSettingsPath { get; init; } = Path.Combine(Environment.GetEnvironmentVariable("CLAUDE_CONFIG_DIR")
        ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude"), "settings.json");
    public TimeSpan Timeout { get; init; } = TimeSpan.FromMinutes(15);
    public TimeSpan HeartbeatInterval { get; init; } = TimeSpan.FromSeconds(15);
    public TimeSpan LeaseDuration { get; init; } = TimeSpan.FromSeconds(90);
    public TimeSpan CancelGrace { get; init; } = TimeSpan.FromSeconds(10);
    public int MaxPreSubmissionRetries { get; init; } = 2;
    public int MaxOutputBytes { get; init; } = 1024 * 1024;
    public int MaxInputBytes { get; init; } = 64 * 1024;

    public Uri PrivateApiOrigin()
    {
        if (!Uri.TryCreate(ApiUrl, UriKind.Absolute, out var uri)
            || !uri.IsLoopback || uri.Scheme is not ("http" or "https")
            || uri.UserInfo.Length != 0 || uri.AbsolutePath != "/" || uri.Query.Length != 0 || uri.Fragment.Length != 0)
            throw new WorkerRequestException("Structured tasks require a configured loopback API origin.", 503);
        return uri;
    }
}
