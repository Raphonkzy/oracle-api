import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAiClient } from "../src/ai/client";
import { loadConfig } from "../src/config";

/** Required settings only. The key and endpoint are fake values for the fake provider below. */
const base = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/test",
  BETTER_AUTH_SECRET: "x".repeat(32),
  AI_BASE_URL: "https://ai.example/v1",
  AI_API_KEY: "test-key",
};
const messages = [{ role: "user" as const, content: "hi" }];

/** Makes one completion and returns the JSON body that the client sent to the provider. */
async function sentBody(client: ReturnType<typeof createAiClient>, extra: { reasoningEffort?: string | null } = {}): Promise<Record<string, unknown>> {
  const bodies: Record<string, unknown>[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    await client.complete({ messages, maxTokens: 10, ...extra });
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(bodies.length, 1);
  return bodies[0];
}

describe("AI_REASONING_EFFORT", () => {
  it("defaults to none, and the request carries reasoning_effort none", async () => {
    const config = loadConfig({ ...base });
    assert.equal(config.aiReasoningEffort, "none");
    assert.ok(config.ai);
    const client = createAiClient({ ...config.ai, reasoningEffort: config.aiReasoningEffort });
    assert.equal((await sentBody(client)).reasoning_effort, "none");
  });

  it("sends no reasoning_effort field when the value is empty", async () => {
    const config = loadConfig({ ...base, AI_REASONING_EFFORT: "" });
    assert.equal(config.aiReasoningEffort, "");
    assert.ok(config.ai);
    const client = createAiClient({ ...config.ai, reasoningEffort: config.aiReasoningEffort });
    assert.equal("reasoning_effort" in (await sentBody(client)), false);
  });

  it("sends no field when the client gets no value at all", async () => {
    const client = createAiClient({ baseUrl: "https://ai.example/v1", apiKey: "k", model: "m" });
    assert.equal("reasoning_effort" in (await sentBody(client)), false);
  });

  it("a single call can override the configured value, and null sends no field", async () => {
    const client = createAiClient({ baseUrl: "https://ai.example/v1", apiKey: "k", model: "m", reasoningEffort: "none" });
    assert.equal((await sentBody(client, { reasoningEffort: "high" })).reasoning_effort, "high");
    assert.equal("reasoning_effort" in (await sentBody(client, { reasoningEffort: null })), false);
  });
});
