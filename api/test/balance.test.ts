import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { sql } from "drizzle-orm";
import { balanceOf, createContext, seedAccounts, type Client, type TestContext } from "./helpers";

type Check = { actual: number; diff: number; adj: string | null };

describe("update saldo", () => {
  let ctx: TestContext;
  let c: Client;
  let ids: Awaited<ReturnType<typeof seedAccounts>>;
  before(async () => {
    ctx = await createContext();
    c = await ctx.signUp("balance@example.com");
    ids = await seedAccounts(c);
  });
  after(async () => ctx.close());

  const checks = async (): Promise<Check[]> =>
    ((await ctx.db.execute(sql`select actual_balance::bigint as actual, difference::bigint as diff, adjustment_transaction_id as adj from balance_checks order by created_at`)) as unknown as { actual: string; diff: string; adj: string | null }[]).map((r) => ({
      actual: Number(r.actual),
      diff: Number(r.diff),
      adj: r.adj,
    }));
  const adjustments = async () => Number(((await ctx.db.execute(sql`select count(*)::int as n from transactions where kind = 'adjustment'`)) as unknown as { n: number }[])[0].n);

  it("a lower real balance books a negative adjustment", async () => {
    const res = await c.post(`/api/v1/accounts/${ids.myBCA}/balance-checks`, { actualBalance: 4_247_500, date: "2026-11-19" });
    assert.equal(res.status, 201);
    assert.equal(res.body.difference, -2_500);
    assert.ok(res.body.adjustmentId);
    assert.equal(res.body.account.balance, 4_247_500);
    const ledger = (await c.get(`/api/v1/accounts/${ids.myBCA}/ledger`)).body.items;
    assert.deepEqual([ledger[0].kind, ledger[0].amount, ledger[0].runningBalance, ledger[0].date], ["adjustment", -2_500, 4_247_500, "2026-11-19"]);
    assert.deepEqual((await checks()).at(-1), { actual: 4_247_500, diff: -2_500, adj: res.body.adjustmentId });
  });

  it("a higher real balance books a positive adjustment", async () => {
    const res = await c.post(`/api/v1/accounts/${ids.GoPay}/balance-checks`, { actualBalance: 300_000, date: "2026-11-19" });
    assert.deepEqual([res.body.difference, res.body.account.balance], [64_500, 300_000]);
  });

  it("when the balance already matches, no adjustment is booked but the check is recorded", async () => {
    const adjBefore = await adjustments();
    const checksBefore = (await checks()).length;
    const res = await c.post(`/api/v1/accounts/${ids.myBCA}/balance-checks`, { actualBalance: 4_247_500, date: "2026-11-20" });
    assert.equal(res.status, 201);
    assert.deepEqual([res.body.difference, res.body.adjustmentId], [0, null]);
    assert.equal(await adjustments(), adjBefore);
    assert.equal((await checks()).length, checksBefore + 1);
    assert.deepEqual((await checks()).at(-1), { actual: 4_247_500, diff: 0, adj: null });
  });

  it("a paylater account is checked against what is owed (a negative balance)", async () => {
    // The app asks for the bill and sends it negative, like the starting balance.
    const res = await c.post(`/api/v1/accounts/${ids.SPayLater}/balance-checks`, { actualBalance: -300_000, date: "2026-11-19" });
    assert.deepEqual([res.body.difference, res.body.account.balance], [150_000, -300_000]);
    assert.equal((await c.get("/api/v1/summary")).body.debts, 300_000);
  });

  it("a zero balance is valid, and so is going negative", async () => {
    assert.equal((await c.post(`/api/v1/accounts/${ids.DANA}/balance-checks`, { actualBalance: 0, date: "2026-11-19" })).body.difference, 0);
    const neg = await c.post(`/api/v1/accounts/${ids.DANA}/balance-checks`, { actualBalance: -1_000, date: "2026-11-19" });
    assert.deepEqual([neg.status, neg.body.account.balance], [201, -1_000]);
  });

  it("the adjustment keeps the running balance in the ledger consistent", async () => {
    await c.post("/api/v1/transactions", { kind: "expense", accountId: ids.Celengan, amount: 10_000, date: "2026-11-10", categoryId: null });
    await c.post(`/api/v1/accounts/${ids.Celengan}/balance-checks`, { actualBalance: 85_000, date: "2026-11-12" });
    await c.post("/api/v1/transactions", { kind: "income", accountId: ids.Celengan, amount: 5_000, date: "2026-11-15", categoryId: null });
    const rows = (await c.get(`/api/v1/accounts/${ids.Celengan}/ledger`)).body.items as { kind: string; amount: number; runningBalance: number }[];
    assert.deepEqual(rows.map((r) => [r.kind, r.amount, r.runningBalance]), [["income", 5_000, 90_000], ["adjustment", -5_000, 85_000], ["expense", -10_000, 90_000]]);
    assert.equal(await balanceOf(c, ids.Celengan), 90_000);
  });

  it("two updates at the same moment cannot book the same difference twice", async () => {
    const adjBefore = await adjustments();
    const [a, b] = await Promise.all([
      c.post(`/api/v1/accounts/${ids["BYOND by BSI"]}/balance-checks`, { actualBalance: 1_700_000, date: "2026-11-19" }),
      c.post(`/api/v1/accounts/${ids["BYOND by BSI"]}/balance-checks`, { actualBalance: 1_700_000, date: "2026-11-19" }),
    ]);
    assert.deepEqual([a.status, b.status], [201, 201]);
    assert.deepEqual([a.body.difference, b.body.difference].sort((x, y) => x - y), [-100_000, 0]);
    assert.equal(await balanceOf(c, ids["BYOND by BSI"]), 1_700_000);
    assert.equal(await adjustments(), adjBefore + 1);
  });

  it("rejects bad bodies and does not change anything", async () => {
    const adjBefore = await adjustments();
    const checksBefore = (await checks()).length;
    for (const body of [{}, { actualBalance: "1000", date: "2026-11-19" }, { actualBalance: 1.5, date: "2026-11-19" }, { actualBalance: 1_000_000_000_000, date: "2026-11-19" }, { actualBalance: 100, date: "2026-02-31" }, { actualBalance: 100 }]) {
      const res = await c.post(`/api/v1/accounts/${ids.myBCA}/balance-checks`, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal((await c.post("/api/v1/accounts/not-a-uuid/balance-checks", { actualBalance: 1, date: "2026-11-19" })).status, 404);
    assert.equal(await adjustments(), adjBefore);
    assert.equal((await checks()).length, checksBefore);
  });
});
