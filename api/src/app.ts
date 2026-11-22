import { cycleMonth, firstError, insightsQuery, settingsInput, budgetsInput, budgetsQuery, categoryCreateInput, categoryPatchInput, exportQuery, monthParam, statsQuery, trendQuery, suggestionsQuery, summaryQuery, todayISO, type PublicConfig } from "@oracle/core";
import type { Db } from "@oracle/db/client";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { canSignUp, type Auth, type SignupMode } from "./auth";
import { HttpError } from "./errors";
import { accessLog, noStore, rateLimit, tooLarge, type RateLimitOptions } from "./middleware";
import { paramId, parseBody, parseQuery, type AppEnv } from "./http";
import type { AiClient } from "./ai/client";
import { accountRoutes } from "./routes/accounts";
import { aiRoutes } from "./routes/ai";
import { transactionRoutes, transferRoutes } from "./routes/transactions";
import { copyPreviousBudgets, getBudgets, setBudgets } from "./services/budgets";
import { archiveCategory, createCategory, listCategories, listProviders, updateCategory } from "./services/catalog";
import { exportTransactionsCsv } from "./services/export";
import { getSuggestions } from "./services/suggestions";
import { getInsights, getStatsCategories, getStatsDetails, getStatsFlow, getStatsTrend } from "./services/stats";
import { getCycleStart, getSettings, setSettings } from "./services/settings";
import { getSummary } from "./services/summary";

export type AppDeps = {
  auth: Auth;
  db: Db;
  signupMode: SignupMode;
  corsOrigins?: string[];
  /** Injected so tests can fix "today". */
  now?: () => Date;
  /** Requests allowed per client address and window. `false` turns the limit off (tests). */
  rateLimit?: RateLimitOptions | false;
  /** Writes one line per request. Off in tests. */
  log?: boolean;
  /** The AI client, or null when the assistant is switched off. */
  ai?: AiClient | null;
  /** Assistant calls per person and hour. */
  aiPerHour?: number;
  /** True when the server can email a password reset code. The sign-in screen shows "Forgot password" only then. */
  passwordReset?: boolean;
};

/** The :month part of a path, as YYYY-MM. A bad value is a 400, not a crash. */
function pathMonth(raw: string): string {
  const parsed = monthParam.safeParse({ month: raw });
  if (!parsed.success) throw new HttpError(400, "validation", firstError(parsed.error));
  return parsed.data.month;
}

const error = (code: string, message: string, details?: Record<string, string | number>) => ({ error: { code, message, ...(details ? { details } : {}) } });

export function createApp({ auth, db, signupMode, corsOrigins = [], now = () => new Date(), rateLimit: limit = { max: 600, windowMs: 60_000 }, log = false, ai = null, aiPerHour = 40, passwordReset = false }: AppDeps) {
  const app = new Hono<AppEnv>();
  if (log) app.use("*", accessLog());
  app.use("*", secureHeaders());

  if (corsOrigins.length) app.use("/api/*", cors({ origin: corsOrigins, credentials: true, allowHeaders: ["Content-Type", "Authorization"] }));

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json(error(err.code, err.message, err.details), err.status);
    console.error(err);
    return c.json(error("internal", "Something went wrong on the server."), 500);
  });
  app.notFound((c) => c.json(error("not_found", "Route not found."), 404));

  app.get("/api/health", async (c) => {
    try {
      await db.execute(sql`select 1`);
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });

  // Login, sign-up and session routes are served by Better Auth. Its own limits cover login attempts; this one covers body size.
  app.use("/api/auth/*", bodyLimit({ maxSize: 16 * 1024, onError: tooLarge() }));
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  const v1 = new Hono<AppEnv>();
  v1.use("*", noStore());
  if (limit) v1.use("*", rateLimit(limit));
  // The biggest real request is the onboarding batch, about 15 KB. Anything near 256 KB is a mistake or an attack.
  v1.use("*", bodyLimit({ maxSize: 256 * 1024, onError: tooLarge() }));

  v1.get("/public/config", async (c) => c.json({ signupOpen: await canSignUp(db, signupMode), passwordReset } satisfies PublicConfig));

  v1.use("*", async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) throw new HttpError(401, "unauthorized", "Not signed in. Please sign in first.");
    c.set("userId", session.user.id);
    c.set("user", session.user);
    await next();
  });

  v1.get("/me", (c) => {
    const user = c.get("user");
    return c.json({ user: { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt } });
  });
  v1.get("/providers", async (c) => c.json({ providers: await listProviders(db) }));
  v1.get("/categories", async (c) => c.json({ categories: await listCategories(db, c.get("userId")) }));
  v1.post("/categories", async (c) => c.json({ category: await createCategory(db, c.get("userId"), await parseBody(c, categoryCreateInput)) }, 201));
  v1.post("/categories/:id/archive", async (c) => {
    await archiveCategory(db, c.get("userId"), paramId(c));
    return c.body(null, 204);
  });
  v1.get("/suggestions", async (c) => {
    const { kind } = parseQuery(c, suggestionsQuery);
    return c.json({ items: await getSuggestions(db, c.get("userId"), kind, todayISO(now()), now()) });
  });
  v1.patch("/categories/:id", async (c) => {
    const id = paramId(c);
    return c.json({ category: await updateCategory(db, c.get("userId"), id, await parseBody(c, categoryPatchInput)) });
  });
  v1.get("/export/transactions.csv", async (c) => {
    const csv = await exportTransactionsCsv(db, c.get("userId"), parseQuery(c, exportQuery));
    return c.body(csv, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="oracle-transactions-${todayISO(now())}.csv"`,
    });
  });
  v1.get("/summary", async (c) => {
    const { period, date } = parseQuery(c, summaryQuery);
    return c.json(await getSummary(db, c.get("userId"), period, todayISO(now()), date));
  });
  v1.get("/stats/flow", async (c) => {
    const { period, date } = parseQuery(c, statsQuery);
    return c.json(await getStatsFlow(db, c.get("userId"), period, todayISO(now()), date));
  });
  v1.get("/stats/categories", async (c) => {
    const { period, date } = parseQuery(c, statsQuery);
    return c.json(await getStatsCategories(db, c.get("userId"), period, todayISO(now()), date));
  });
  v1.get("/stats/trend", async (c) => {
    const { months, date } = parseQuery(c, trendQuery);
    return c.json(await getStatsTrend(db, c.get("userId"), months, todayISO(now()), date));
  });
  v1.get("/stats/details", async (c) => {
    const { period, date } = parseQuery(c, statsQuery);
    return c.json(await getStatsDetails(db, c.get("userId"), period, todayISO(now()), date));
  });
  v1.get("/insights", async (c) => {
    const { period, language, date } = parseQuery(c, insightsQuery);
    return c.json(await getInsights(db, c.get("userId"), period, todayISO(now()), language, date));
  });
  v1.get("/budgets", async (c) => {
    const userId = c.get("userId");
    const month = parseQuery(c, budgetsQuery).month ?? cycleMonth(todayISO(now()), await getCycleStart(db, userId));
    return c.json(await getBudgets(db, userId, month));
  });
  v1.get("/settings", async (c) => c.json(await getSettings(db, c.get("userId"))));
  v1.put("/settings", async (c) => c.json(await setSettings(db, c.get("userId"), await parseBody(c, settingsInput))));
  v1.put("/budgets/:month", async (c) => {
    const month = pathMonth(c.req.param("month"));
    const { items } = await parseBody(c, budgetsInput);
    return c.json(await setBudgets(db, c.get("userId"), month, items));
  });
  v1.post("/budgets/:month/copy-previous", async (c) => {
    const month = pathMonth(c.req.param("month"));
    return c.json(await copyPreviousBudgets(db, c.get("userId"), month));
  });
  v1.route("/ai", aiRoutes({ db, ai, now, perHour: aiPerHour }));
  v1.route("/accounts", accountRoutes(db));
  v1.route("/transactions", transactionRoutes(db));
  v1.route("/transfers", transferRoutes(db));

  app.route("/api/v1", v1);
  return app;
}
