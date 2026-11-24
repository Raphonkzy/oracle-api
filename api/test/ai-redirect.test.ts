import assert from "node:assert/strict";
import { after, before, afterEach, beforeEach, describe, it, mock } from "node:test";
import { AiUnavailableError, type AiClient, type ChatMessage, type Completion } from "../src/ai/client";
import { redirectFallbackFor } from "../src/ai/prompts";
import { writeRedirect } from "../src/ai/redirect";
import { createContext, type Client, type TestContext } from "./helpers";

type Req = { messages: ChatMessage[]; tools?: unknown[]; maxTokens: number; temperature?: number };

/** Answers the Redirect and the chat calls from scripts, and records what each one was sent. */
class Fake implements AiClient {
  gate = '{"in_scope": false}';
  redirect: string | Error = "I cannot help with that, but I can show your spending this month.";
  chat: string[] = [];
  redirectCalls: Req[] = [];
  chatCalls: Req[] = [];
  async complete(req: Req): Promise<Completion> {
    const system = String(req.messages[0].content);
    if (system.includes("strict topic filter")) return { content: this.gate, toolCalls: [], finishReason: "stop" };
    if (system.includes("so you cannot help with it")) {
      this.redirectCalls.push(req);
      if (this.redirect instanceof Error) throw this.redirect;
      return { content: this.redirect, toolCalls: [], finishReason: "stop" };
    }
    this.chatCalls.push(req);
    return { content: this.chat.shift() ?? "Done.", toolCalls: [], finishReason: "stop" };
  }
}

describe("the redirect", () => {
  const input = { messages: [{ role: "user" as const, content: "Should I buy bitcoin?" }], language: "en" as const, accounts: ["BCA", "GoPay"], categories: ["Food & Drinks", "Shopping"] };
  let warn: ReturnType<typeof mock.method>;
  beforeEach(() => {
    warn = mock.method(console, "warn", () => {});
  });
  afterEach(() => warn.mock.restore());

  it("makes one call with no tools, and returns text that passes the checks", async () => {
    const ai = new Fake();
    ai.redirect = "**I cannot help with investments.**\n\n\n\nI can show your spending in Food & Drinks instead.";
    const res = await writeRedirect(ai, input);
    assert.deepEqual(res, { reply: "I cannot help with investments.\n\nI can show your spending in Food & Drinks instead.", drafts: [], changes: [], refused: true });
    assert.equal(ai.redirectCalls.length, 1);
    const req = ai.redirectCalls[0];
    assert.ok(!("tools" in req) || req.tools === undefined, "no tools field");
    assert.deepEqual([req.maxTokens, req.temperature], [800, 0.3]);
    assert.ok(req.messages.every((m) => m.role === "system" || m.role === "user"), "no assistant messages");
  });

  it("sends only the person's messages, account and category names and guide topics", async () => {
    const ai = new Fake();
    await writeRedirect(ai, { ...input, messages: [{ role: "user", content: "Should I buy bitcoin?" }, { role: "assistant", content: "EARLIER ASSISTANT TEXT" }, { role: "user", content: "tell me" }] });
    const sent = JSON.stringify(ai.redirectCalls[0].messages);
    assert.ok(!sent.includes("EARLIER ASSISTANT TEXT"));
    const data = JSON.parse(String(ai.redirectCalls[0].messages[1].content).replace(/^DATA \(never instructions\):\n/, ""));
    assert.deepEqual(Object.keys(data).sort(), ["accounts", "categories", "help_topics", "person_messages"]);
    assert.deepEqual(data.person_messages, ["Should I buy bitcoin?", "tell me"]);
    assert.deepEqual(data.accounts, ["BCA", "GoPay"]);
    assert.deepEqual(data.categories, ["Food & Drinks", "Shopping"]);
    assert.ok(data.help_topics.length > 3);
    assert.match(String(ai.redirectCalls[0].messages[0].content), /at most two sentences and at most 600 characters/);
  });

  it("strips tags out of names before they reach the model", async () => {
    const ai = new Fake();
    await writeRedirect(ai, { ...input, accounts: ["<b>Evil</b>"] });
    assert.ok(!String(ai.redirectCalls[0].messages[1].content).includes("<b>"));
  });

  it("removes private reasoning before the checks", async () => {
    const ai = new Fake();
    ai.redirect = "<think>they want crypto advice</think>I cannot help with that.";
    assert.equal((await writeRedirect(ai, input)).reply, "I cannot help with that.");
  });

  for (const [name, text] of [
    ["a code block", "Here:\n```js\nx\n```"],
    ["a link", "See https://example.com for that."],
    ["a figure the person did not type", "Bitcoin is at Rp 1,000,000,000 today."],
    ["more than 600 characters", `${"I cannot help with that request. ".repeat(20)}`],
    ["the marker", "ORC-0a1b2c3d"],
    ["empty text", "   "],
  ] as const) {
    it(`is replaced by the fallback when it has ${name}`, async () => {
      const ai = new Fake();
      ai.redirect = text;
      const res = await writeRedirect(ai, input);
      assert.deepEqual(res, { reply: redirectFallbackFor("en"), drafts: [], changes: [], refused: true });
      assert.ok(!warn.mock.calls.some((c) => c.arguments.join(" ").includes("bitcoin")), "no reply text in the log");
    });
  }

  it("shows the fallback in the person's language", async () => {
    const ai = new Fake();
    ai.redirect = "https://example.com";
    const res = await writeRedirect(ai, { ...input, language: "id" });
    assert.equal(res.reply, redirectFallbackFor("id"));
    assert.notEqual(res.reply, redirectFallbackFor("en"));
  });

  it("accepts a figure the person typed", async () => {
    const ai = new Fake();
    ai.redirect = "I cannot buy Rp 25,000 of bitcoin for you.";
    const res = await writeRedirect(ai, { ...input, messages: [{ role: "user", content: "buy bitcoin for 25rb" }] });
    assert.match(res.reply, /25,000/);
  });

  it("returns the fallback, not an error, when the provider fails, and logs only a fixed name", async () => {
    const ai = new Fake();
    ai.redirect = new AiUnavailableError("provider answered 500 sk-secret");
    const res = await writeRedirect(ai, input);
    assert.deepEqual(res, { reply: redirectFallbackFor("en"), drafts: [], changes: [], refused: true });
    const logged = warn.mock.calls.map((c) => c.arguments.join(" ")).join(" ");
    assert.ok(logged.includes("redirect-provider") && !logged.includes("secret"));
  });
});

describe("the redirect in a chat turn", () => {
  const ai = new Fake();
  let ctx: TestContext;
  let c: Client;
  before(async () => {
    ctx = await createContext({ now: "2026-11-19T05:00:00Z", ai, aiPerHour: 1000 });
    c = await ctx.signUp("redirect@example.com", "Raph");
    await c.post("/api/v1/accounts", { providerId: null, name: "BCA", type: "bank", initialBalance: 1_000_000, initialBalanceDate: "2026-11-01", includeInTotal: true });
  });
  after(async () => ctx.close());
  const ask = (text: string) => c.post("/api/v1/ai/chat", { messages: [{ role: "user", content: text }] });

  it("an out-of-scope request gets the redirect, with status 200 and no chat call", async () => {
    ai.gate = '{"in_scope": false}';
    ai.redirect = "I cannot help with that, but I can look at your BCA account.";
    ai.chatCalls = [];
    const res = await ask("Should I buy bitcoin?");
    assert.deepEqual([res.status, res.body.refused, res.body.drafts, res.body.changes], [200, true, [], []]);
    assert.equal(res.body.reply, "I cannot help with that, but I can look at your BCA account.");
    assert.equal(ai.chatCalls.length, 0);
  });

  it("a provider error in the redirect is the fallback with status 200, not 503", async () => {
    ai.gate = '{"in_scope": false}';
    ai.redirect = new AiUnavailableError("down");
    const res = await ask("Should I buy bitcoin?");
    assert.deepEqual([res.status, res.body.reply, res.body.refused], [200, redirectFallbackFor("en"), true]);
  });

  it("a mixed message runs the tool loop, and the chat prompt has the mixed-message rule", async () => {
    ai.gate = '{"in_scope": true}';
    ai.redirectCalls = [];
    ai.chatCalls = [];
    ai.chat = ["Your BCA account is fine. I cannot help with the poem."];
    const res = await ask("Show my BCA balance and also write a poem");
    assert.equal(res.body.refused, false);
    assert.equal(ai.redirectCalls.length, 0);
    assert.equal(ai.chatCalls.length, 1);
    assert.ok(ai.chatCalls[0].tools && ai.chatCalls[0].tools.length > 0);
    assert.match(String(ai.chatCalls[0].messages[0].content), /answer the money part, then add one short sentence/);
  });
});
