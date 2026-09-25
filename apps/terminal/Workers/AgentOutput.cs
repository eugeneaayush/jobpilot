using System.Text.Json;

namespace JobPilot.Terminal.Workers;

internal sealed class AgentOutput
{
    internal const string Schema = """
        {"type":"object","additionalProperties":false,"properties":{"outcome":{"type":"string","enum":["completed","blocked","needs_user"]},"summary":{"type":"string","maxLength":2000},"nextAction":{"type":"string","enum":["none","dispatch_worker","wait","request_user"]},"data":{"type":"object","additionalProperties":false,"properties":{"mock":{"type":"boolean"},"attemptId":{"type":["string","null"]},"receipt":{"type":["string","null"]},"taskKind":{"type":["string","null"],"enum":["plan","score","prepare_apply","apply","reconcile",null]}},"required":["mock","attemptId","receipt","taskKind"]}},"required":["outcome","summary","nextAction","data"]}
        """;

    public JsonElement? Result { get; private set; }
    public string? SessionId { get; private set; }
    public bool Error { get; private set; }

    public void Feed(string line)
    {
        using var document = JsonDocument.Parse(line);
        var value = document.RootElement;
        if (value.ValueKind != JsonValueKind.Object) throw new InvalidDataException("Agent event must be a JSON object.");
        if (value.TryGetProperty("session_id", out var session) && session.ValueKind == JsonValueKind.String) SessionId = session.GetString();
        if (value.TryGetProperty("thread_id", out var thread) && thread.ValueKind == JsonValueKind.String) SessionId = thread.GetString();
        var type = value.TryGetProperty("type", out var eventType) ? eventType.GetString() : null;
        if (type is "error" or "turn.failed") Error = true;
        if (type == "result")
        {
            Result = null;
            Error = value.TryGetProperty("is_error", out var failed) && failed.ValueKind == JsonValueKind.True;
            if (value.TryGetProperty("structured_output", out var structured)) SetResult(structured);
            else if (value.TryGetProperty("result", out var text) && text.ValueKind == JsonValueKind.String) ParseResult(text.GetString()!);
        }
        if (type == "item.completed" && value.TryGetProperty("item", out var item)
            && item.TryGetProperty("type", out var itemType) && itemType.GetString() == "agent_message"
            && item.TryGetProperty("text", out var message) && message.ValueKind == JsonValueKind.String)
            ParseResult(message.GetString()!);
    }

    private void ParseResult(string text)
    {
        Result = null;
        try
        {
            using var document = JsonDocument.Parse(text);
            SetResult(document.RootElement);
        }
        catch (JsonException)
        {
            // Provider progress text can precede the final structured message.
        }
    }

    private void SetResult(JsonElement result)
    {
        if (IsValid(result)) Result = result.Clone();
    }

    internal static bool IsValid(JsonElement value) => value.ValueKind == JsonValueKind.Object
        && value.EnumerateObject().Count() == 4
        && value.TryGetProperty("outcome", out var outcome) && outcome.ValueKind == JsonValueKind.String
        && outcome.GetString() is "completed" or "blocked" or "needs_user"
        && value.TryGetProperty("summary", out var summary) && summary.ValueKind == JsonValueKind.String && summary.GetString()!.Length <= 2000
        && value.TryGetProperty("nextAction", out var action) && action.ValueKind == JsonValueKind.String
        && action.GetString() is "none" or "dispatch_worker" or "wait" or "request_user"
        && value.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Object
        && data.EnumerateObject().Count() == 4
        && data.TryGetProperty("mock", out var mock) && mock.ValueKind is JsonValueKind.True or JsonValueKind.False
        && NullableString(data, "attemptId") && NullableString(data, "receipt")
        && NullableString(data, "taskKind") && data.GetProperty("taskKind").GetString() is null or "plan" or "score" or "prepare_apply" or "apply" or "reconcile";

    private static bool NullableString(JsonElement value, string key) => value.TryGetProperty(key, out var child)
        && child.ValueKind is JsonValueKind.Null or JsonValueKind.String;
}
