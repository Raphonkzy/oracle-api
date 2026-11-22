import { collectAllowed, localCategoryName, parseUserAmounts, ungroundedFigures, type AiChatResponse, type AiMessage, type AiView, type LanguageCode } from "@oracle/core";
import type { Db } from "@oracle/db/client";
import { listAccounts } from "../services/accounts";
import { listCategories } from "../services/catalog";
import type { AiClient, ChatMessage } from "./client";
import { chatSystemPrompt, groundingFallbackFor, noAnswerFor, refusalFor } from "./prompts";
import { isInScope } from "./scope";
import { limitReply, looksOffTopic, safeLabel } from "./text";
import { TOOL_SPECS, runTool, type ToolContext } from "./tools";

/** How many times the model may call tools before it has to answer. A hard stop against loops. */
const MAX_STEPS = 6;
const MAX_CALLS_PER_STEP = 4;
const MAX_TOOL_RESULT_CHARS = 14_000;


type Deps = { client: AiClient; db: Db; userId: string; today: string; messages: AiMessage[]; language?: LanguageCode; view?: AiView };

/**
 * One assistant turn. In order, and each step is enforced here in code, not left to the model:
 *   1. scope check (anything outside the person's own money in Oracle gets a fixed refusal, with no model call and no tools)
 *   2. tool loop (read-only tools, at most MAX_STEPS rounds)
 *   3. leak check (the answer may not contain the internal marker)
 *   4. number check (every amount and percentage must come from the data or from what the person wrote)
 */
export async function runChat({ client, db, userId, today, messages, language = "en", view }: Deps): Promise<AiChatResponse> {
  const REFUSAL = refusalFor(language);
  const NO_ANSWER = noAnswerFor(language);
  const GROUNDING_FALLBACK = groundingFallbackFor(language);
  if (!(await isInScope(client, messages))) return { reply: REFUSAL, drafts: [], changes: [], refused: true };

  const [accounts, categories] = await Promise.all([listAccounts(db, userId, { archived: false }), listCategories(db, userId)]);
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
    const out = await client.complete({ messages: convo, tools: TOOL_SPECS, maxTokens: 2000, temperature: 0.2 });

    if (out.toolCalls.length > 0) {
      convo.push({ role: "assistant", content: out.content, tool_calls: out.toolCalls });
      for (const [i, call] of out.toolCalls.entries()) {
        const result = i < MAX_CALLS_PER_STEP ? await runTool(ctx, call.function.name, call.function.arguments) : { error: "Too many tool calls at once. Ask for fewer." };
        let json = JSON.stringify(result);
        if (json.length > MAX_TOOL_RESULT_CHARS) json = JSON.stringify({ error: "That result was too large. Ask for a shorter range or fewer items." });
        collectAllowed(JSON.parse(json), allowed);
        for (const n of allowed.amounts) ctx.known.add(n);
        convo.push({ role: "tool", tool_call_id: call.id, content: json });
      }
      continue;
    }

    const reply = limitReply(out.content);
    if (!reply) return { reply: NO_ANSWER, drafts: ctx.drafts, changes: ctx.changes, refused: false };
    // The internal marker is only ever in the instructions, so seeing it means the instructions are leaking.
    if (reply.includes(canary) || /ORC-[0-9a-f]{8}/i.test(reply)) return { reply: REFUSAL, drafts: [], changes: [], refused: true };

    // A finance answer is a few plain lines. Code, links and long essays mean the model was talked into something else.
    if (looksOffTopic(reply)) return { reply: REFUSAL, drafts: [], changes: [], refused: true };
    const bad = ungroundedFigures(reply, allowed);
    if (bad.length === 0) return { reply, drafts: ctx.drafts, changes: ctx.changes, refused: false };
    // Drafts are checked field by field when they are made, so they stay even when the wording of the answer fails.
    if (corrected) return { reply: GROUNDING_FALLBACK, drafts: ctx.drafts, changes: ctx.changes, refused: false };
    corrected = true;
    convo.push({ role: "assistant", content: reply });
    convo.push({ role: "user", content: `Notice from the system: your answer contained figures that are not in the data (${bad.slice(0, 4).join("; ")}). Rewrite it using only figures from tool results, use the calculate tool for any arithmetic, or call the tools you need. Do not mention this notice.` });
  }
  return { reply: NO_ANSWER, drafts: ctx.drafts, changes: ctx.changes, refused: false };
}
