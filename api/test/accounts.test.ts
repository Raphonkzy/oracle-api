import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { updateAccount } from "../src/services/accounts";
import { balanceOf, createContext, seedAccounts, type Client, type TestContext } from "./helpers";

const acct = (over: Record<string, unknown> = {}) => ({
  providerId: null, name: "Dompet", type: "cash", initialBalance: 0, initialBalanceDate: "2026-11-01", includeInTotal: true, ...over,
});

describe("catalog", () => {
  let ctx: TestContext;
  before(async () => (ctx = await createContext()));
  after(async () => ctx.close());

  it("lists the 87 built-in providers with their app names", async () => {
    const c = await ctx.signUp("a@example.com");
    const { status, body } = await c.get("/api/v1/providers");
    assert.equal(status, 200);
    assert.equal(body.providers.length, 87);
    const bsi = body.providers.find((p: { id: string }) => p.id === "bsi");
    assert.ok(bsi.aliases.includes("BYOND"));
    assert.equal(bsi.type, "bank");
  });
});

describe("accounts", () => {
  let ctx: TestContext;
  let c: Client;
  let ids: Awaited<ReturnType<typeof seedAccounts>>;
  before(async () => {
    ctx = await createContext();
    c = await ctx.signUp("owner@example.com");
  });
  after(async () => ctx.close());

  it("starts empty with a zero summary", async () => {
    assert.deepEqual((await c.get("/api/v1/accounts")).body, { accounts: [] });
    const s = (await c.get("/api/v1/summary")).body;
    assert.deepEqual([s.total, s.assets, s.debts, s.countedCount, s.allCount, s.ring.length, s.recent.length], [0, 0, 0, 0, 0, 0, 0]);
  });

  it("onboarding creates many accounts in order, balances equal the starting balance", async () => {
    ids = await seedAccounts(c);
    const { accounts } = (await c.get("/api/v1/accounts")).body;
    assert.deepEqual(accounts.map((a: { name: string }) => a.name), ["myBCA", "BYOND by BSI", "GoPay", "DANA", "SPayLater", "Celengan"]);
    assert.deepEqual(accounts.map((a: { sortOrder: number }) => a.sortOrder), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(accounts.map((a: { balance: number }) => a.balance), [4_250_000, 1_800_000, 235_500, 0, -450_000, 100_000]);
    assert.equal(accounts[0].providerId, "bca");
    assert.equal(accounts[5].providerId, null);
    assert.equal(accounts[0].archivedAt, null);
    assert.equal(accounts[0].initialBalanceDate, "2026-11-01");
  });

  it("summary: debts reduce the total, ring has only positive balances", async () => {
    const s = (await c.get("/api/v1/summary")).body;
    assert.equal(s.total, 5_935_500);
    assert.equal(s.assets, 6_385_500);
    assert.equal(s.debts, 450_000);
    assert.equal(s.countedCount, 6);
    assert.deepEqual(s.ring.map((r: { name: string }) => r.name), ["myBCA", "BYOND by BSI", "GoPay", "Celengan"]);
    assert.ok(Math.abs(s.ring.reduce((sum: number, r: { share: number }) => sum + r.share, 0) - 1) < 1e-9);
    assert.deepEqual(s.byType.map((t: { type: string; amount: number }) => [t.type, t.amount]), [["bank", 6_050_000], ["ewallet", 235_500], ["cash", 100_000]]);
  });

  it("new accounts go to the end of the list", async () => {
    const res = await c.post("/api/v1/accounts", acct({ name: "Koperasi", type: "other", initialBalance: 50_000 }));
    assert.equal(res.status, 201);
    assert.equal(res.body.account.sortOrder, 6);
    assert.equal(res.body.account.balance, 50_000);
  });

  it("rejects bad input with a readable message", async () => {
    const cases: [unknown, RegExp][] = [
      [acct({ name: "   " }), /Account name is required/],
      [acct({ name: "x".repeat(61) }), /Maximum 60/],
      [acct({ type: "crypto" }), /./],
      [acct({ initialBalance: 1.5 }), /./],
      [acct({ initialBalance: 1_000_000_000_000 }), /./],
      [acct({ initialBalance: "100" }), /./],
      [acct({ initialBalanceDate: "2026-02-31" }), /Invalid date/],
      [acct({ includeInTotal: "yes" }), /./],
      [{}, /./],
    ];
    for (const [body, message] of cases) {
      const res = await c.post("/api/v1/accounts", body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.error.code, "validation");
      assert.match(res.body.error.message, message);
    }
    assert.equal((await c.post("/api/v1/accounts/batch", { accounts: [] })).body.error.message, "Pick at least one bank account or e-wallet.");
    assert.equal((await c.post("/api/v1/accounts/batch", { accounts: Array.from({ length: 51 }, () => acct()) })).status, 400);
  });

  it("an unknown provider is a clean 400 and nothing is created", async () => {
    const before = (await c.get("/api/v1/accounts")).body.accounts.length;
    const res = await c.post("/api/v1/accounts/batch", { accounts: [acct({ name: "Ok" }), acct({ name: "Palsu", providerId: "bank-fiktif" })] });
    assert.deepEqual([res.status, res.body.error.code], [400, "unknown_provider"]);
    assert.equal((await c.get("/api/v1/accounts")).body.accounts.length, before);
  });

  it("PATCH changes only what is sent", async () => {
    const res = await c.patch(`/api/v1/accounts/${ids.DANA}`, { name: "DANA Utama", includeInTotal: false });
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.account.name, res.body.account.includeInTotal, res.body.account.type, res.body.account.balance], ["DANA Utama", false, "ewallet", 0]);
    assert.equal((await c.patch(`/api/v1/accounts/${ids.DANA}`, {})).status, 400);
    assert.equal((await c.patch(`/api/v1/accounts/${ids.DANA}`, { name: "" })).status, 400);
    assert.equal((await c.patch("/api/v1/accounts/00000000-0000-4000-8000-000000000000", { name: "X" })).status, 404);
    assert.equal((await c.patch("/api/v1/accounts/not-a-uuid", { name: "X" })).status, 404);
    await c.patch(`/api/v1/accounts/${ids.DANA}`, { name: "DANA", includeInTotal: true });
  });

  it("excluded accounts keep their balance but leave the total", async () => {
    const before = (await c.get("/api/v1/summary")).body;
    await c.patch(`/api/v1/accounts/${ids.Celengan}`, { includeInTotal: false });
    const after = (await c.get("/api/v1/summary")).body;
    assert.equal(after.total, before.total - 100_000);
    assert.equal(after.countedCount, before.countedCount - 1);
    assert.equal(after.allCount, before.allCount);
    assert.equal(await balanceOf(c, ids.Celengan), 100_000);
    await c.patch(`/api/v1/accounts/${ids.Celengan}`, { includeInTotal: true });
  });

  it("archive hides an account from totals and active lists, restore brings it back", async () => {
    const total = (await c.get("/api/v1/summary")).body.total;
    const archived = await c.post(`/api/v1/accounts/${ids.Celengan}/archive`);
    assert.equal(archived.status, 200);
    assert.ok(archived.body.account.archivedAt);
    assert.equal((await c.post(`/api/v1/accounts/${ids.Celengan}/archive`)).status, 200); // idempotent

    const active = (await c.get("/api/v1/accounts")).body.accounts.map((a: { id: string }) => a.id);
    assert.ok(!active.includes(ids.Celengan));
    const list = (await c.get("/api/v1/accounts?archived=true")).body.accounts;
    assert.deepEqual(list.map((a: { id: string }) => a.id), [ids.Celengan]);
    assert.equal(list[0].balance, 100_000);
    assert.equal((await c.get("/api/v1/summary")).body.total, total - 100_000);
    assert.equal((await c.get(`/api/v1/accounts/${ids.Celengan}`)).status, 200); // still readable
    assert.equal((await c.get(`/api/v1/accounts/${ids.Celengan}/ledger`)).status, 200);

    // No new money can be booked on an archived account.
    const tx = await c.post("/api/v1/transactions", { kind: "expense", accountId: ids.Celengan, amount: 1000, date: "2026-11-02", categoryId: null });
    assert.deepEqual([tx.status, tx.body.error.code], [400, "account_unavailable"]);
    const upd = await c.post(`/api/v1/accounts/${ids.Celengan}/balance-checks`, { actualBalance: 5, date: "2026-11-02" });
    assert.equal(upd.status, 400);

    const restored = await c.post(`/api/v1/accounts/${ids.Celengan}/restore`);
    assert.equal(restored.body.account.archivedAt, null);
    assert.equal((await c.get("/api/v1/summary")).body.total, total);
    assert.equal((await c.get("/api/v1/accounts?archived=maybe")).status, 400);
  });

  it("reorder sets the exact order and rejects partial, duplicate or foreign lists", async () => {
    const current = (await c.get("/api/v1/accounts")).body.accounts.map((a: { id: string }) => a.id) as string[];
    const reversed = [...current].reverse();
    const ok = await c.post("/api/v1/accounts/reorder", { ids: reversed });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.accounts.map((a: { id: string }) => a.id), reversed);
    assert.deepEqual((await c.get("/api/v1/accounts")).body.accounts.map((a: { id: string }) => a.id), reversed);

    for (const bad of [reversed.slice(1), [...reversed, reversed[0]], [reversed[0], reversed[0], ...reversed.slice(2)], [...reversed.slice(1), "00000000-0000-4000-8000-000000000000"]]) {
      const res = await c.post("/api/v1/accounts/reorder", { ids: bad });
      assert.deepEqual([res.status, res.body.error.code], [400, "invalid_order"]);
    }
    assert.equal((await c.post("/api/v1/accounts/reorder", { ids: [] })).status, 400);
    assert.deepEqual((await c.get("/api/v1/accounts")).body.accounts.map((a: { id: string }) => a.id), reversed);
  });

  it("an archived account is not part of the order", async () => {
    await c.post(`/api/v1/accounts/${ids.DANA}/archive`);
    const active = (await c.get("/api/v1/accounts")).body.accounts.map((a: { id: string }) => a.id) as string[];
    assert.ok(!active.includes(ids.DANA));
    assert.equal((await c.post("/api/v1/accounts/reorder", { ids: [...active, ids.DANA] })).status, 400);
    assert.equal((await c.post("/api/v1/accounts/reorder", { ids: [...active].reverse() })).status, 200);
  });
});

describe("account ownership before row locks", () => {
  let ctx: TestContext;
  let alice: Client;
  let bob: Client;
  let bobIds: Awaited<ReturnType<typeof seedAccounts>>;
  before(async () => {
    ctx = await createContext();
    alice = await ctx.signUp("alice-lock@example.com");
    bob = await ctx.signUp("bob-lock@example.com");
    bobIds = await seedAccounts(bob);
  });
  after(async () => ctx.close());

  it("a foreign account id gives 404 and no transaction (no row lock) is started", async () => {
    // Records every database method the service calls, so a lock taken on Bob's row would show up as a transaction.
    const calls: string[] = [];
    const spied = new Proxy(ctx.db, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          calls.push(String(prop));
          return value.apply(target, args);
        };
      },
    }) as typeof ctx.db;
    const aliceId = (await alice.get("/api/v1/me")).body.user.id as string;
    await assert.rejects(updateAccount(spied, aliceId, bobIds.myBCA, { name: "Hijack" }), (e: { status?: number }) => e.status === 404);
    assert.ok(!calls.includes("transaction"), `no transaction expected, got calls: ${calls.join(", ")}`);
    assert.equal((await bob.get(`/api/v1/accounts/${bobIds.myBCA}`)).body.account.name, "myBCA", "Bob's account is unchanged");
  });

  it("a foreign account id gives 404 over HTTP and leaves Bob's account unchanged", async () => {
    const res = await alice.patch(`/api/v1/accounts/${bobIds.myBCA}`, { name: "Hijack", initialBalance: 0 });
    assert.equal(res.status, 404);
    assert.equal((await bob.get(`/api/v1/accounts/${bobIds.myBCA}`)).body.account.name, "myBCA");
  });

  it("an own account still updates", async () => {
    const res = await bob.patch(`/api/v1/accounts/${bobIds.myBCA}`, { name: "myBCA 2" });
    assert.equal(res.status, 200);
    assert.equal(res.body.account.name, "myBCA 2");
  });
});
