import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createContext, PASSWORD, type TestContext } from "./helpers";

describe("auth and basics (open sign-up)", () => {
  let ctx: TestContext;
  before(async () => {
    ctx = await createContext({ signupMode: "open" });
  });
  after(async () => ctx.close());

  it("health check answers without a login", async () => {
    const res = await ctx.anonymous.get("/api/health");
    assert.deepEqual([res.status, res.body], [200, { ok: true }]);
  });

  it("every data endpoint needs a login", async () => {
    for (const [method, path] of [
      ["GET", "/api/v1/me"], ["GET", "/api/v1/summary"], ["GET", "/api/v1/accounts"], ["POST", "/api/v1/accounts"],
      ["GET", "/api/v1/transactions"], ["POST", "/api/v1/transactions"], ["POST", "/api/v1/transfers"],
      ["GET", "/api/v1/providers"], ["GET", "/api/v1/categories"],
    ]) {
      const res = await ctx.anonymous.call(method, path, method === "POST" ? {} : undefined);
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal(res.body.error.code, "unauthorized");
    }
  });

  it("a garbage cookie is not a session", async () => {
    const res = await ctx.app.request("/api/v1/me", { headers: { cookie: "better-auth.session_token=nope.nope" } });
    assert.equal(res.status, 401);
  });

  it("public config says sign-up is open", async () => {
    const res = await ctx.anonymous.get("/api/v1/public/config");
    assert.deepEqual([res.status, res.body], [200, { signupOpen: true, passwordReset: false }]);
  });

  it("sign-up logs in, gives the 27 default categories, and /me works", async () => {
    const owner = await ctx.signUp("owner@example.com", "Raph Test");
    const me = await owner.get("/api/v1/me");
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, "owner@example.com");
    assert.equal(me.body.user.name, "Raph Test");
    const cats = (await owner.get("/api/v1/categories")).body.categories as { kind: string; name: string }[];
    assert.equal(cats.length, 27);
    assert.equal(cats.filter((c) => c.kind === "expense").length, 15);
    assert.equal(cats.filter((c) => c.kind === "income").length, 12);
    assert.ok(cats.some((c) => c.name === "Financial & Fees"));
    assert.ok(!cats.some((c) => c.name === "Other"), "no catch-all: people add their own category instead");
  });

  it("sign-in rejects a wrong password and accepts the right one", async () => {
    assert.equal((await ctx.signInRaw("owner@example.com", "wrong-password-1")).status, 401);
    assert.equal((await ctx.signInRaw("nobody@example.com", PASSWORD)).status, 401);
    const again = await ctx.signIn("owner@example.com");
    assert.equal((await again.get("/api/v1/me")).status, 200);
  });

  it("the phone app can sign in with its app scheme and use the cookie", async () => {
    const res = await ctx.app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", "expo-origin": "oracle://" },
      body: JSON.stringify({ email: "owner@example.com", password: PASSWORD }),
    });
    assert.equal(res.status, 200);
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
    assert.match(cookie, /^better-auth\.session_token=/);
    const me = await ctx.app.request("/api/v1/me", { headers: { cookie } });
    assert.equal(me.status, 200);
  });
  it("rejects a short password and a duplicate email", async () => {
    const short = await ctx.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { origin: "http://localhost:3200", "content-type": "application/json" },
      body: JSON.stringify({ name: "X", email: "short@example.com", password: "short" }),
    });
    assert.equal(short.status, 400);
    const dup = await ctx.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { origin: "http://localhost:3200", "content-type": "application/json" },
      body: JSON.stringify({ name: "X", email: "owner@example.com", password: PASSWORD }),
    });
    assert.ok(dup.status >= 400 && dup.status < 500);
  });

  it("sign-out ends the session", async () => {
    const c = await ctx.signUp("leaving@example.com");
    assert.equal((await c.post("/api/auth/sign-out")).status, 200);
    // The cookie in `c` is now stale server-side.
    assert.equal((await c.get("/api/v1/me")).status, 401);
  });

  it("unknown routes and broken JSON get clean JSON errors", async () => {
    const owner = await ctx.signIn("owner@example.com");
    const nf = await owner.get("/api/v1/nope");
    assert.deepEqual([nf.status, nf.body.error.code], [404, "not_found"]);
    const bad = await owner.call("POST", "/api/v1/transactions", undefined, "{not json");
    assert.deepEqual([bad.status, bad.body.error.code], [400, "invalid_json"]);
  });
});

describe("auth (closed sign-up)", () => {
  let ctx: TestContext;
  before(async () => {
    ctx = await createContext({ signupMode: "closed" });
  });
  after(async () => ctx.close());

  it("only the first user can sign up", async () => {
    assert.equal((await ctx.anonymous.get("/api/v1/public/config")).body.signupOpen, true);
    const owner = await ctx.signUp("owner@example.com");
    assert.equal((await owner.get("/api/v1/me")).status, 200);

    assert.equal((await ctx.anonymous.get("/api/v1/public/config")).body.signupOpen, false);
    const second = await ctx.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { origin: "http://localhost:3200", "content-type": "application/json" },
      body: JSON.stringify({ name: "Intruder", email: "intruder@example.com", password: PASSWORD }),
    });
    assert.equal(second.status, 403);
    assert.match(((await second.json()) as { message: string }).message, /closed/);
    assert.equal((await ctx.signInRaw("intruder@example.com", PASSWORD)).status, 401);
  });
});
