import assert from "node:assert/strict";
import { Hono } from "hono";
import { after, before, describe, it } from "node:test";
import { accessLog, rateLimit } from "../src/middleware";
import { createContext, PASSWORD, type Client, type TestContext } from "./helpers";

describe("account security (Better Auth routes the Profile screen uses)", () => {
  let ctx: TestContext;
  before(async () => {
    ctx = await createContext({ signupMode: "open" });
  });
  after(async () => ctx.close());

  it("changes the password only with the right current one, and the old one stops working", async () => {
    const c = await ctx.signUp("pw@example.com");
    const wrong = await c.post("/api/auth/change-password", { currentPassword: "not-my-password", newPassword: "a-brand-new-password" });
    assert.equal(wrong.status, 400);
    assert.equal((await ctx.signInRaw("pw@example.com", PASSWORD)).status, 200, "a failed attempt changed nothing");
    const short = await c.post("/api/auth/change-password", { currentPassword: PASSWORD, newPassword: "short" });
    assert.equal(short.status, 400, "the new password still has to be 10 characters");
    const ok = await c.post("/api/auth/change-password", { currentPassword: PASSWORD, newPassword: "a-brand-new-password" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await ctx.signInRaw("pw@example.com", PASSWORD)).status, 401);
    assert.equal((await ctx.signInRaw("pw@example.com", "a-brand-new-password")).status, 200);
  });

  it("can sign every other device out while this one stays signed in", async () => {
    const phone = await ctx.signUp("devices@example.com");
    const tablet = await ctx.signIn("devices@example.com");
    const laptop = await ctx.signIn("devices@example.com");
    const sessions = await phone.get("/api/auth/list-sessions");
    assert.equal(sessions.status, 200);
    assert.equal(sessions.body.length, 3);
    const res = await phone.post("/api/auth/revoke-other-sessions");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await phone.get("/api/v1/me")).status, 200, "this device is still in");
    assert.equal((await tablet.get("/api/v1/me")).status, 401);
    assert.equal((await laptop.get("/api/v1/me")).status, 401);
  });

  it("changing the password can sign the other devices out at the same time", async () => {
    const phone = await ctx.signUp("both@example.com");
    const other = await ctx.signIn("both@example.com");
    const res = await phone.post("/api/auth/change-password", { currentPassword: PASSWORD, newPassword: "another-new-password", revokeOtherSessions: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await other.get("/api/v1/me")).status, 401);
  });

  it("changes the display name", async () => {
    const c = await ctx.signUp("name@example.com", "Old Name");
    const res = await c.post("/api/auth/update-user", { name: "New Name" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await c.get("/api/v1/me")).body.user.name, "New Name");
  });

  it("signing out ends the session for good", async () => {
    const c = await ctx.signUp("out@example.com");
    assert.equal((await c.post("/api/auth/sign-out")).status, 200);
    assert.equal((await c.get("/api/v1/me")).status, 401, "the old cookie no longer works");
  });
});

describe("hardening", () => {
  let ctx: TestContext;
  let c: Client;
  before(async () => {
    ctx = await createContext({ signupMode: "open", rateLimit: { max: 8, windowMs: 60_000 } });
    c = await ctx.signUp("hard@example.com");
  });
  after(async () => ctx.close());

  it("keeps private answers out of caches and sets safe browser headers", async () => {
    const res = await ctx.app.request("/api/v1/me", { headers: { cookie: c.cookie, "cf-connecting-ip": "10.0.0.1" } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  });

  it("refuses a request body that is far too large", async () => {
    const huge = JSON.stringify({ accounts: [], padding: "x".repeat(300 * 1024) });
    const res = await c.call("POST", "/api/v1/accounts/batch", undefined, huge);
    assert.deepEqual([res.status, res.body.error.code], [413, "too_large"]);
    const fine = await c.post("/api/v1/accounts/batch", { accounts: [] });
    assert.equal(fine.status, 400, "a normal body still reaches validation");
  });

  it("also refuses a huge body on the login routes", async () => {
    const res = await ctx.app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3200" },
      body: JSON.stringify({ email: "a@b.co", password: "x".repeat(40 * 1024) }),
    });
    assert.equal(res.status, 413);
  });

  it("slows a client that sends far too many requests, and counts each address separately", async () => {
    const hit = (ip: string) => ctx.app.request("/api/v1/public/config", { headers: { "cf-connecting-ip": ip } });
    for (let i = 0; i < 8; i += 1) assert.equal((await hit("203.0.113.7")).status, 200);
    const blocked = await hit("203.0.113.7");
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
    assert.equal(((await blocked.json()) as { error: { code: string } }).error.code, "rate_limited");
    assert.equal((await hit("203.0.113.8")).status, 200, "someone else is not affected");
    assert.equal((await ctx.app.request("/api/health")).status, 200, "the health check is never limited");
  });
});

describe("rateLimit middleware window", () => {
  it("starts a fresh window once the old one has passed", async () => {
    let t = 1_000;
    const app = new Hono();
    app.use("*", rateLimit({ max: 2, windowMs: 1_000 }, () => t));
    app.get("/", (c) => c.text("ok"));
    const status = async () => (await app.request("/")).status;
    assert.deepEqual([await status(), await status(), await status()], [200, 200, 429]);
    t += 999;
    assert.equal(await status(), 429, "still inside the window");
    t += 1;
    assert.equal(await status(), 200, "window over");
  });
});

describe("access log", () => {
  it("writes method, path, status and time, never the query string, headers or body", async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => void lines.push(args.join(" "));
    try {
      const app = new Hono();
      app.use("*", accessLog());
      app.get("/api/v1/transactions", (c) => c.json({ ok: true }));
      app.post("/api/auth/sign-in/email", (c) => c.json({ ok: true }));
      app.get("/api/health", (c) => c.json({ ok: true }));
      await app.request("/api/v1/transactions?q=my+secret+search&from=2026-01-01", { headers: { cookie: "better-auth.session_token=SECRET-TOKEN" } });
      await app.request("/api/auth/sign-in/email", { method: "POST", body: JSON.stringify({ password: "hunter2-hunter2" }) });
      await app.request("/api/health");
    } finally {
      console.log = original;
    }
    assert.equal(lines.length, 2, "the health check is not logged");
    assert.match(lines[0], /^GET \/api\/v1\/transactions 200 \d+ms$/);
    assert.match(lines[1], /^POST \/api\/auth\/sign-in\/email 200 \d+ms$/);
    assert.ok(!lines.join("\n").match(/secret|SECRET|hunter2|\?/));
  });
});

describe("rateLimit client key ignores X-Forwarded-For (SEC-02)", () => {
  const limited = () => {
    const app = new Hono();
    app.use("*", rateLimit({ max: 2, windowMs: 60_000 }));
    app.get("/", (c) => c.text("ok"));
    return app;
  };
  const hit = async (app: Hono, headers: Record<string, string>) => (await app.request("/", { headers })).status;

  it("a spoofed X-Forwarded-For with the same cf-connecting-ip still shares one limit", async () => {
    const app = limited();
    const cf = { "cf-connecting-ip": "198.51.100.1" };
    const statuses = [
      await hit(app, { ...cf, "x-forwarded-for": "10.0.0.1, 192.168.1.1" }),
      await hit(app, { ...cf, "x-forwarded-for": "10.0.0.2, 192.168.1.1" }),
      await hit(app, { ...cf, "x-forwarded-for": "10.0.0.3, 192.168.1.1" }),
    ];
    assert.deepEqual(statuses, [200, 200, 429], "rotating the forged value does not reset the limit");
  });

  it("a spoofed X-Forwarded-For with a new cf-connecting-ip gets a new bucket", async () => {
    const app = limited();
    const xff = { "x-forwarded-for": "10.0.0.1" };
    assert.deepEqual(
      [
        await hit(app, { ...xff, "cf-connecting-ip": "198.51.100.10" }),
        await hit(app, { ...xff, "cf-connecting-ip": "198.51.100.10" }),
        await hit(app, { ...xff, "cf-connecting-ip": "198.51.100.10" }),
      ],
      [200, 200, 429],
    );
    assert.equal(await hit(app, { ...xff, "cf-connecting-ip": "198.51.100.11" }), 200, "another real client is not affected");
  });

  it("without cf-connecting-ip, X-Forwarded-For is never read: every caller shares the direct bucket", async () => {
    const app = limited();
    const statuses = [
      await hit(app, { "x-forwarded-for": "10.0.0.1" }),
      await hit(app, { "x-forwarded-for": "10.0.0.2" }),
      await hit(app, { "x-forwarded-for": "10.0.0.3" }),
    ];
    assert.deepEqual(statuses, [200, 200, 429]);
  });
});

describe("sign-in limit (Better Auth) ignores X-Forwarded-For (SEC-02)", () => {
  it("a spoofed X-Forwarded-For with the same cf-connecting-ip is still limited on sign-in", async () => {
    const ctx = await createContext({ authRateLimit: true });
    await ctx.signUp("login@example.com");
    const attempt = (xff: string) =>
      ctx.app.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: { origin: "http://localhost:3200", "content-type": "application/json", "cf-connecting-ip": "198.51.100.20", "x-forwarded-for": xff },
        body: JSON.stringify({ email: "login@example.com", password: "wrong-password-1" }),
      });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await attempt(`10.0.0.${i + 1}`)).status);
    assert.ok(statuses.slice(0, 5).every((s) => s !== 429), `the first five attempts are not refused: ${statuses}`);
    assert.equal(statuses[5], 429, "rotating the forged X-Forwarded-For does not reset the sign-in limit");
    await ctx.close();
  });
});
