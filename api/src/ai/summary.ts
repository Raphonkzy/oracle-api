import { collectAllowed, formatRupiah, insightWords, localCategoryName, ungroundedFigures, type AiSummary, type LanguageCode, type Period } from "@oracle/core";
import type { Db } from "@oracle/db/client";
import { createHash } from "node:crypto";
import { getInsights } from "../services/stats";
import type { AiClient } from "./client";
import { LANGUAGE_NAME, summaryPrompt } from "./prompts";
import { limitReply } from "./text";
import { runTool, type ToolContext } from "./tools";

type Facts = { overview: Record<string, unknown>; spending: Record<string, unknown>; budgets: Record<string, unknown>; insights: Record<string, unknown> };
type Deps = { client: AiClient | null; db: Db; userId: string; today: string; period: Period; language?: LanguageCode };

const WORD: Record<Period, string> = { week: "this week", month: "this month", year: "this year" };
const cache = new Map<string, { text: string; at: number }>();
const CACHE_MS = 30 * 60 * 1000;

async function gather(db: Db, userId: string, today: string, period: Period, language: LanguageCode): Promise<Facts> {
  const ctx: ToolContext = { db, userId, today, language, drafts: [], changes: [], known: new Set(), userWroteDigits: false };
  const [overview, spending, budgets, insights] = await Promise.all([
    runTool(ctx, "get_overview", JSON.stringify({ period })),
    runTool(ctx, "get_spending", JSON.stringify({ period })),
    runTool(ctx, "get_budgets", "{}"),
    runTool(ctx, "get_insights", JSON.stringify({ period })),
  ]);
  return { overview, spending, budgets, insights } as Facts;
}

/**
 * The summary without AI: the numbers and the rule-based notes, joined into sentences. It is what the person gets
 * when AI is off, down, or wrote something that did not check out, so the screen is never empty or wrong.
 */
export function rulesSummary(facts: Facts, period: Period, language: LanguageCode = "en", localNotes?: string[]): string {
  const words = insightWords(language);
  const when = words.period[period].this;
  const s = facts.spending as { totalSpending?: number; previousPeriodSpendingSameDays?: number; changePct?: number | null; categories?: { name: string; amount: number }[] };
  const notes = localNotes ?? ((facts.insights as { notes?: { text: string }[] }).notes ?? []).slice(0, 3).map((n) => n.text);
  if (!s.totalSpending) return `${words.spentNone({ when })}${notes.length ? ` ${notes.join(" ")}` : ""}`;
  const parts = [words.spent({ when, amount: formatRupiah(s.totalSpending) })];
  if (s.changePct !== null && s.changePct !== undefined && s.previousPeriodSpendingSameDays) {
    parts.push(words.change({ pct: Math.abs(s.changePct), more: s.changePct >= 0, prev: formatRupiah(s.previousPeriodSpendingSameDays) }));
  }
  const top = s.categories?.[0];
  if (top) parts.push(words.topCategory({ name: localCategoryName(top.name, language), amount: formatRupiah(top.amount) }));
  return [...parts, ...notes].join(" ");
}
/** Always returns text. `source` says whether AI wrote it or the rules did. */
export async function runSummary({ client, db, userId, today, period, language = "en" }: Deps): Promise<AiSummary> {
  const facts = await gather(db, userId, today, period, language);
  // The notes are worded in the person's language, so the fallback reads naturally.
  const localNotes = language === "en" ? undefined : (await getInsights(db, userId, period, today, language)).items.slice(0, 3).map((n) => n.text);
  const fallback: AiSummary = { period, text: rulesSummary(facts, period, language, localNotes), source: "rules" };
  if (!client) return fallback;

  const factsJson = JSON.stringify(facts);
  const key = `${userId}:${period}:${language}:${createHash("sha256").update(factsJson).digest("hex").slice(0, 24)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return { period, text: hit.text, source: "ai" };

  try {
    const out = await client.complete({
      messages: [
        { role: "system", content: summaryPrompt(language) },
        { role: "user", content: `LANGUAGE: ${LANGUAGE_NAME[language]}\nPERIOD: ${period} (${WORD[period]})\nFACTS:\n${factsJson}` },
      ],
      maxTokens: 1500,
      temperature: 0.3,
    });
    const text = limitReply(out.content, 900).replace(/\s*\n+\s*/g, " ");
    // Every amount and percentage must be in the facts. If not, the AI text is thrown away.
    if (!text || ungroundedFigures(text, collectAllowed(facts)).length > 0) return fallback;
    cache.set(key, { text, at: Date.now() });
    if (cache.size > 500) cache.delete(cache.keys().next().value as string);
    return { period, text, source: "ai" };
  } catch {
    return fallback;
  }
}
