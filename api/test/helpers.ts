import assert from "node:assert/strict";
import { createDb } from "@oracle/db/client";
import { runMigrations } from "@oracle/db/migrate";
import { seedProviders } from "@oracle/db/seed";
import postgres from "postgres";
import type { AiClient } from "../src/ai/client";
import { createApp } from "../src/app";
import type { Mailer } from "../src/mailer";
import { createAuth, type SignupMode } from "../src/auth";

const SECRET = "test-secret-test-secret-test-secret-123";
const API_URL = "http://localhost:3200";
export const PASSWORD = "testpassword123";

// Tests read JSON bodies freely, and the assertions check the shapes, so `any` is deliberate here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Reply = { status: number; body: any };

/** A logged-in caller. Talks to the app in-process, so no port is needed. */
export type Client = {
  email: string;
  /** The session cookie, for tests that need the raw response (files, headers). Empty when not signed in. */
  cookie: string;
  call: (method: string, path: string, body?: unknown, raw?: string) => Promise<Reply>;
  get: (path: string) => Promise<Reply>;
  post: (path: string, body?: unknown) => Promise<Reply>;
  patch: (path: string, body?: unknown) => Promise<Reply>;
  put: (path: string, body?: unknown) => Promise<Reply>;
  del: (path: string) => Promise<Reply>;
};

export async function createContext(opts: { signupMode?: SignupMode; now?: string; rateLimit?: { max: number; windowMs: number }; ai?: AiClient | null; aiPerHour?: number; mailer?: Mailer | null; authRateLimit?: boolean } = {}) {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");

  const dbName = `oracle_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = postgres(adminUrl, { max: 1 });
  await admin.unsafe(`create database ${dbName}`);
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;

  await runMigrations(url.toString());
  const { db, client } = createDb(url.toString(), { max: 8 });
  await seedProviders(db);

  const signupMode = opts.signupMode ?? "open";
  const auth = createAuth({ db, secret: SECRET, baseURL: API_URL, signupMode, rateLimit: opts.authRateLimit ?? false, mailer: opts.mailer ?? null });
  const clock = { now: new Date(opts.now ?? "2026-11-19T05:00:00Z") };
  const app = createApp({ auth, db, signupMode, now: () => clock.now, rateLimit: opts.rateLimit ?? false, ai: opts.ai ?? null, aiPerHour: opts.aiPerHour, passwordReset: !!opts.mailer });

  const request = async (method: string, path: string, cookie: string | null, body?: unknown, raw?: string): Promise<Reply> => {
    const headers: Record<string, string> = { origin: API_URL };
    if (cookie) headers.cookie = cookie;
    let payload: string | undefined;
    if (raw !== undefined) payload = raw;
    else if (body !== undefined) payload = JSON.stringify(body);
    if (payload !== undefined) headers["content-type"] = "application/json";
    const res = await app.request(path, { method, headers, body: payload });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  const clientFor = (email: string, cookie: string | null): Client => {
    const call = (method: string, path: string, body?: unknown, raw?: string) => request(method, path, cookie, body, raw);
    return {
      email,
      cookie: cookie ?? "",
      call,
      get: (path) => call("GET", path),
      post: (path, body) => call("POST", path, body),
      patch: (path, body) => call("PATCH", path, body),
      put: (path, body) => call("PUT", path, body),
      del: (path) => call("DELETE", path),
    };
  };

  const cookieFrom = (res: Response) =>
    res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

  async function signUp(email: string, name = "Tester"): Promise<Client> {
    const res = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { origin: API_URL, "content-type": "application/json" },
      body: JSON.stringify({ name, email, password: PASSWORD }),
    });
    assert.equal(res.status, 200, `sign-up failed: ${await res.text()}`);
    return clientFor(email, cookieFrom(res));
  }

  async function signInRaw(email: string, password: string) {
    return app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { origin: API_URL, "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
  }

  async function signIn(email: string): Promise<Client> {
    const res = await signInRaw(email, PASSWORD);
    assert.equal(res.status, 200);
    return clientFor(email, cookieFrom(res));
  }

  async function close() {
    await client.end();
    await admin.unsafe(`drop database if exists ${dbName} with (force)`);
    await admin.end();
  }

  return { app, auth, hono: app, db, clock, anonymous: clientFor("anonymous", null), signUp, signIn, signInRaw, close };
}

export type TestContext = Awaited<ReturnType<typeof createContext>>;

/** Typed shortcuts for the data most tests need. */
export async function seedAccounts(c: Client, today = "2026-11-01") {
  const res = await c.post("/api/v1/accounts/batch", {
    accounts: [
      { providerId: "bca", name: "myBCA", type: "bank", initialBalance: 4_250_000, initialBalanceDate: today, includeInTotal: true },
      { providerId: "bsi", name: "BYOND by BSI", type: "bank", initialBalance: 1_800_000, initialBalanceDate: today, includeInTotal: true },
      { providerId: "gopay", name: "GoPay", type: "ewallet", initialBalance: 235_500, initialBalanceDate: today, includeInTotal: true },
      { providerId: "dana", name: "DANA", type: "ewallet", initialBalance: 0, initialBalanceDate: today, includeInTotal: true },
      { providerId: "spaylater", name: "SPayLater", type: "paylater", initialBalance: -450_000, initialBalanceDate: today, includeInTotal: true },
      { providerId: null, name: "Celengan", type: "cash", initialBalance: 100_000, initialBalanceDate: today, includeInTotal: true },
    ],
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const ids: Record<string, string> = {};
  for (const a of res.body.accounts) ids[a.name] = a.id;
  return ids as Record<"myBCA" | "BYOND by BSI" | "GoPay" | "DANA" | "SPayLater" | "Celengan", string>;
}

export async function categoryId(c: Client, name: string, kind: "income" | "expense") {
  const res = await c.get("/api/v1/categories");
  const found = res.body.categories.find((x: { name: string; kind: string }) => x.name === name && x.kind === kind);
  assert.ok(found, `category ${name} (${kind}) not found`);
  return found.id as string;
}

export const balanceOf = async (c: Client, id: string) => (await c.get(`/api/v1/accounts/${id}`)).body.account.balance as number;
