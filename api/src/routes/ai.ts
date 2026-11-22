import { aiChatInput, aiSummaryInput, todayISO, type AiStatus } from "@oracle/core";
import type { Db } from "@oracle/db/client";
import { Hono } from "hono";
import { AiUnavailableError, type AiClient } from "../ai/client";
import { runChat } from "../ai/chat";
import { createUserLimiter } from "../ai/limit";
import { runSummary } from "../ai/summary";
import { HttpError } from "../errors";
import { parseBody, type AppEnv } from "../http";

type Deps = { db: Db; ai: AiClient | null; now: () => Date; perHour: number };

/** AI is optional and costs money, so each person gets a modest number of calls an hour. */
export function aiRoutes({ db, ai, now, perHour }: Deps) {
  const r = new Hono<AppEnv>();
  const limiter = createUserLimiter({ max: perHour, windowMs: 60 * 60 * 1000 });

  const guard = (userId: string) => {
    const taken = limiter.take(userId);
    if (!taken.ok) throw new HttpError(429, "ai_rate_limited", `You have asked a lot in the last hour. Try again in ${Math.ceil(taken.retryAfter / 60)} minute(s).`);
  };
  /** A provider failure is not the person's fault and says nothing about the provider's details. */
  const unavailable = (e: unknown): never => {
    if (e instanceof AiUnavailableError) {
      console.error(`ai unavailable: ${e.message}`);
      throw new HttpError(503, "ai_unavailable", "The assistant is not available right now. Try again in a moment.");
    }
    throw e;
  };

  r.get("/status", (c) => c.json({ enabled: ai !== null } satisfies AiStatus));

  // Without AI the summary still works: it is the rule-based text.
  r.post("/summary", async (c) => {
    const userId = c.get("userId");
    const { period, language } = await parseBody(c, aiSummaryInput);
    if (ai) guard(userId);
    return c.json(await runSummary({ client: ai, db, userId, today: todayISO(now()), period, language }));
  });

  r.post("/chat", async (c) => {
    if (!ai) throw new HttpError(503, "ai_disabled", "The assistant is switched off on this server.");
    const userId = c.get("userId");
    const { messages, language, view } = await parseBody(c, aiChatInput);
    guard(userId);
    try {
      return c.json(await runChat({ client: ai, db, userId, today: todayISO(now()), messages, language, view }));
    } catch (e) {
      return unavailable(e);
    }
  });

  return r;
}
