/** A minimal client for any OpenAI-compatible chat endpoint. */

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
export type ToolSpec = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };
export type Completion = { content: string; toolCalls: ToolCall[]; finishReason: string };

export interface AiClient {
  complete(req: {
    messages: ChatMessage[];
    tools?: ToolSpec[];
    maxTokens: number;
    temperature?: number;
    /** Overrides the configured reasoning effort for this call. null sends no reasoning_effort field. */
    reasoningEffort?: string | null;
  }): Promise<Completion>;
}

/** The provider failed, timed out or answered nonsense. The details stay in the server log, never in a response. */
export class AiUnavailableError extends Error {}

type Config = {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  /** Sent as reasoning_effort on every call unless a call overrides it. Empty means the field is not sent. */
  reasoningEffort?: string;
};

export function createAiClient({ baseUrl, apiKey, model, timeoutMs = 60_000, reasoningEffort = "" }: Config): AiClient {
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return {
    async complete({ messages, tools, maxTokens, temperature = 0.2, reasoningEffort: perCall }) {
      const effort = perCall === undefined ? reasoningEffort : (perCall ?? "");
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          // Some providers refuse requests that carry no User-Agent.
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "User-Agent": "oracle-api/1.0" },
          body: JSON.stringify({ model, messages, ...(tools?.length ? { tools } : {}), max_tokens: maxTokens, temperature, ...(effort ? { reasoning_effort: effort } : {}) }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        throw new AiUnavailableError(`request failed: ${e instanceof Error ? e.name : "unknown"}`);
      }
      if (!res.ok) throw new AiUnavailableError(`provider answered ${res.status}`);
      let body: { choices?: { finish_reason?: string; message?: { content?: string | null; tool_calls?: ToolCall[] } }[] };
      try {
        body = (await res.json()) as typeof body;
      } catch {
        throw new AiUnavailableError("provider answered with something that is not JSON");
      }
      const choice = body.choices?.[0];
      if (!choice?.message) throw new AiUnavailableError("provider answered without a message");
      // `reasoning_content` (the model's private thinking) is deliberately never read, so it can never reach a person.
      return { content: choice.message.content ?? "", toolCalls: choice.message.tool_calls ?? [], finishReason: choice.finish_reason ?? "" };
    },
  };
}
