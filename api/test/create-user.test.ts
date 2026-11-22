import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createUser } from "../src/cli/create-user";
import { createContext, type TestContext } from "./helpers";

describe("creating an account from the server", () => {
  let ctx: TestContext;
  const opts = { secret: "x".repeat(40), baseURL: "http://localhost:3200" };
  before(async () => {
    // Sign-up is closed and the owner already exists: the public cannot register, the server admin still can.
    ctx = await createContext({ signupMode: "closed" });
    await ctx.app.request("/api/auth/sign-up/email", { method: "POST", headers: { origin: "http://localhost:3200", "content-type": "application/json" }, body: JSON.stringify({ name: "Owner", email: "owner@example.com", password: "owner-password-123" }) });
  });
  after(async () => ctx.close());

  it("the public still cannot sign up", async () => {
    const res = await ctx.app.request("/api/auth/sign-up/email", { method: "POST", headers: { origin: "http://localhost:3200", "content-type": "application/json" }, body: JSON.stringify({ name: "Intruder", email: "intruder@example.com", password: "intruder-password-1" }) });
    assert.equal(res.status, 403);
  });

  it("creates an account that can sign in, with the default categories and nothing else", async () => {
    assert.equal(await createUser(ctx.db, opts, "Friend@Example.com", "  My   Friend ", "a-friend-password-1"), null);
    const signIn = await ctx.signInRaw("friend@example.com", "a-friend-password-1");
    assert.equal(signIn.status, 200);
    const cookie = signIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const me = await ctx.app.request("/api/v1/me", { headers: { cookie, origin: "http://localhost:3200" } });
    assert.equal(((await me.json()) as { user: { name: string } }).user.name, "My Friend");
    const cats = await ctx.app.request("/api/v1/categories", { headers: { cookie, origin: "http://localhost:3200" } });
    assert.equal(((await cats.json()) as { categories: unknown[] }).categories.length, 27);
    const accounts = await ctx.app.request("/api/v1/accounts", { headers: { cookie, origin: "http://localhost:3200" } });
    assert.deepEqual(((await accounts.json()) as { accounts: unknown[] }).accounts, []);
  });

  it("refuses a second account with the same email, a short password, a bad email and a bad name", async () => {
    assert.match((await createUser(ctx.db, opts, "friend@example.com", "Again", "another-password-1"))!, /already an account/);
    assert.match((await createUser(ctx.db, opts, "x@example.com", "X", "short"))!, /at least 10/);
    assert.match((await createUser(ctx.db, opts, "not-an-email", "X", "a-long-enough-password"))!, /not an email/);
    assert.match((await createUser(ctx.db, opts, "y@example.com", "   ", "a-long-enough-password"))!, /name must have/);
    assert.match((await createUser(ctx.db, opts, "y@example.com", "x".repeat(61), "a-long-enough-password"))!, /name must have/);
  });

  it("does not touch the other accounts", async () => {
    assert.equal((await ctx.signInRaw("owner@example.com", "owner-password-123")).status, 200);
  });
});
