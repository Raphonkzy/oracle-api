import { collectAllowed, localCategoryName, parseUserAmounts, ungroundedFigures, type AiChatResponse, type AiMessage, type AiView, type LanguageCode } from "@oracle/core";
import type { Db } from "@oracle/db/client";
import { listAccounts } from "../services/accounts";
import { listCategories } from "../services/catalog";
import type { AiClient, ChatMessage, ToolCall } from "./client";
import { chatSystemPrompt, groundingFallbackFor, noAnswerFor, redirectFallbackFor } from "./prompts";
import { logCheck, normalizePlainText, rejectRule, stripReasoning } from "./checks";
import { writeRedirect } from "./redirect";
import { isInScope } from "./scope";
import { limitReply, safeLabel } from "./text";
import { TOOL_SPECS, runTool, type ToolContext } from "./tools";

/** How many times the model may call tools before it has to answer. A hard stop against loops. */
const MAX_STEPS = 6;
const MAX_CALLS_PER_STEP = 4;
const MAX_TOOL_RESULT_CHARS = 14_000;
/** The tools that only create cards. They run one at a time, in the order the model asked. */
const PROPOSE_TOOLS = new Set(["propose_transactions", "propose_changes"]);


type Deps = { client: AiClient; db: Db; userId: string; today: string; messages: AiMessage[]; language?: LanguageCode; view?: AiView };

/**
 * One assistant turn. In order, and each step is enforced here in code, not left to the model:
 *   1. scope gate (only the exact verdict `true` goes on; anything else gets a Redirect: one call, no tools)
 *   2. tool loop (read-only tools, at most MAX_STEPS rounds)
 *   3. reply checks (reasoning removed, then marker, code, link, tag and table rejects, then plain-text normalization)
 *   4. number check (every amount and percentage must come from the data or from what the person wrote)
 *   5. length cap, last, so the checks see the whole reply
 */
export async function runChat({ client, db, userId, today, messages, language = "en", view }: Deps): Promise<AiChatResponse> {
  const REDIRECT_FALLBACK = redirectFallbackFor(language);
  const NO_ANSWER = noAnswerFor(language);
  const GROUNDING_FALLBACK = groundingFallbackFor(language);
  // The gate and the account and category reads do not depend on each other, so they run together.
  const [inScope, [accounts, categories]] = await Promise.all([
    isInScope(client, messages),
    Promise.all([listAccounts(db, userId, { archived: false }), listCategories(db, userId)]),
  ]);
  if (!inScope) return writeRedirect(client, { messages, language, accounts: accounts.map((a) => a.name), categories: categories.map((c) => c.name) });
  const canary = `ORC-${crypto.randomUUID().slice(0, 8)}`;
  const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" }).format(new Date(`${today}T00:00:00Z`));
  const system = chatSystemPrompt({
    language,
    today,
    weekday,
    canary,
    accounts: accounts.map((a) => `${safeLabel(a.name)} (${a.type})`),
    // Category names are listed the way the app shows them in the app language.
    expenseCategories: categories.filter((c) => c.kind === "expense").map((c) => safeLabel(localCategoryName(c.name, language))),
    incomeCategories: categories.filter((c) => c.kind === "income").map((c) => safeLabel(localCategoryName(c.name, language))),
    view,
  });

  const userText = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
  const written = parseUserAmounts(userText);
  const allowed = collectAllowed(userText);
  // "25 ribu" is the person's own figure: the answer may say Rp 25,000.
  for (const n of written) allowed.amounts.add(n);
  const ctx: ToolContext = { db, userId, today, language, view, drafts: [], changes: [], known: new Set(written), userWroteDigits: /\d/.test(userText) };
  const convo: ChatMessage[] = [{ role: "system", content: system }, ...messages.map((m) => ({ role: m.role, content: m.content }) as ChatMessage)];

  let corrected = false;
  for (let step = 0; step < MAX_STEPS; step += 1) {
    // After a figure notice the model rewrites its answer. That call keeps the request it had before the reasoning setting existed.
    const out = await client.complete({ messages: convo, tools: TOOL_SPECS, maxTokens: 2000, temperature: 0.2, ...(corrected ? { reasoningEffort: null } : {}) });

    if (out.toolCalls.length > 0) {
      convo.push({ role: "assistant", content: out.content, tool_calls: out.toolCalls });
      const runAt = (i: number, call: ToolCall) => (i < MAX_CALLS_PER_STEP ? runTool(ctx, call.function.name, call.function.arguments) : Promise.resolve({ error: "Too many tool calls at once. Ask for fewer." }));
      // Read-only calls in one round run together. Proposals run one by one, because they append to the shared
      // drafts and changes, and the caps depend on that order.
      const readOnly = out.toolCalls.every((call) => !PROPOSE_TOOLS.has(call.function.name));
      const results: unknown[] = [];
      if (readOnly) results.push(...(await Promise.all(out.toolCalls.map((call, i) => runAt(i, call)))));
      else for (const [i, call] of out.toolCalls.entries()) results.push(await runAt(i, call));
      for (const [i, call] of out.toolCalls.entries()) {
        let json = JSON.stringify(results[i]);
        if (json.length > MAX_TOOL_RESULT_CHARS) json = JSON.stringify({ error: "That result was too large. Ask for a shorter range or fewer items." });
        collectAllowed(JSON.parse(json), allowed);
        for (const n of allowed.amounts) ctx.known.add(n);
        convo.push({ role: "tool", tool_call_id: call.id, content: json });
      }
      continue;
    }

    const stripped = stripReasoning(out.content);
    if (!stripped) return { reply: NO_ANSWER, drafts: ctx.drafts, changes: ctx.changes, refused: false };
    // The internal marker is only ever in the instructions, so seeing it means the instructions are leaking.
    // Code, links, tags and tables mean the model was talked into something else. These run before normalization.
    const rule = rejectRule(stripped, canary);
    if (rule) {
      logCheck(`reply-check:${rule}`);
      return { reply: REDIRECT_FALLBACK, drafts: [], changes: [], refused: true };
    }
    const reply = normalizePlainText(stripped);
    if (!reply) return { reply: NO_ANSWER, drafts: ctx.drafts, changes: ctx.changes, refused: false };
    const bad = ungroundedFigures(reply, allowed);
    if (bad.length === 0) return { reply: limitReply(reply), drafts: ctx.drafts, changes: ctx.changes, refused: false };
    // Drafts are checked field by field when they are made, so they stay even when the wording of the answer fails.
    if (corrected) {
      logCheck("reply-check:figure");
      return { reply: GROUNDING_FALLBACK, drafts: ctx.drafts, changes: ctx.changes, refused: false };
    }
    corrected = true;
    convo.push({ role: "assistant", content: reply });
    convo.push({ role: "user", content: `Notice from the system: your answer contained figures that are not in the data (${bad.slice(0, 4).join("; ")}). Rewrite it using only figures from tool results, use the calculate tool for any arithmetic, or call the tools you need. Do not mention this notice.` });
  }
  return { reply: NO_ANSWER, drafts: ctx.drafts, changes: ctx.changes, refused: false };
}
