import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { categoryId, createContext, type Client, type TestContext } from "./helpers";

describe("choosing a month keeps October and November apart", () => {
  let ctx: TestContext;
  let c: Client;
  let account: string;
  let food: string;

  const add = async (date: string, amount: number) => assert.equal((await c.post("/api/v1/transactions", { kind: "expense", accountId: account, amount, date, categoryId: food, description: `spend ${date}` })).status, 201);

  before(async () => {
    ctx = await createContext({ now: "2026-12-15T05:00:00Z" });
    c = await ctx.signUp("periods@example.com");
    account = (await c.post("/api/v1/accounts", { providerId: null, name: "Bank", type: "bank", initialBalance: 100_000_000, initialBalanceDate: "2026-01-01", includeInTotal: true })).body.account.id;
    food = await categoryId(c, "Food & Drinks", "expense");
    // The edges of each month, and one day in the middle.
    await add("2026-10-01", 1_000);
    await add("2026-10-31", 2_000);
    await add("2026-11-01", 4_000);
    await add("2026-11-15", 8_000);
    await add("2026-11-30", 16_000);
    await add("2026-12-01", 32_000);
    await add("2027-01-01", 64_000);
  });
  after(async () => ctx.close());

  const month = async (date?: string) => (await c.get(`/api/v1/summary?period=month${date ? `&date=${date}` : ""}`)).body;

  it("without a date it shows the current month (December)", async () => {
    const s = await month();
    assert.deepEqual(s.range, { from: "2026-12-01", to: "2026-12-31" });
    assert.equal(s.flow.expense, 32_000);
  });

  it("any day of November shows only November, first and last day included", async () => {
    for (const date of ["2026-11-01", "2026-11-15", "2026-11-30"]) {
      const s = await month(date);
      assert.deepEqual(s.range, { from: "2026-11-01", to: "2026-11-30" }, date);
      assert.equal(s.flow.expense, 28_000, date);
      assert.equal(s.flow.income, 0);
      assert.equal(s.spendingByCategory.length, 1);
      assert.equal(s.spendingByCategory[0].amount, 28_000);
    }
  });

  it("October shows only October", async () => {
    const s = await month("2026-10-20");
    assert.deepEqual(s.range, { from: "2026-10-01", to: "2026-10-31" });
    assert.equal(s.flow.expense, 3_000);
  });

  it("stats for a month match the summary of that month, with the chart bars adding up", async () => {
    const flow = (await c.get("/api/v1/stats/flow?period=month&date=2026-11-10")).body;
    assert.deepEqual(flow.range, { from: "2026-11-01", to: "2026-11-30" });
    assert.equal(flow.total, 28_000);
    assert.equal(flow.buckets.reduce((s: number, b: { amount: number }) => s + b.amount, 0), 28_000);
    assert.equal(flow.previousTotal, 3_000, "the whole of October, because November is finished");
    assert.equal(flow.changePct, 833);
    const cats = (await c.get("/api/v1/stats/categories?period=month&date=2026-11-10")).body;
    assert.equal(cats.total, 28_000);
    assert.equal(cats.items[0].previousAmount, 3_000);
  });

  it("a whole year and a whole week can be looked at too", async () => {
    const year = await c.get("/api/v1/summary?period=year&date=2026-03-01");
    assert.equal(year.body.flow.expense, 1_000 + 2_000 + 4_000 + 8_000 + 16_000 + 32_000);
    const week = await c.get("/api/v1/stats/flow?period=week&date=2026-11-14");
    assert.deepEqual(week.body.range, { from: "2026-11-09", to: "2026-11-15" });
    assert.equal(week.body.total, 8_000);
  });

  it("the year change: the last day of December and the first of January are different years", async () => {
    const y2025 = await c.get("/api/v1/summary?period=year&date=2025-12-31");
    assert.deepEqual(y2025.body.range, { from: "2025-01-01", to: "2025-12-31" });
    assert.equal(y2025.body.flow.expense, 0);
    const y2026 = await c.get("/api/v1/summary?period=year&date=2026-12-31");
    assert.deepEqual(y2026.body.range, { from: "2026-01-01", to: "2026-12-31" });
    assert.equal(y2026.body.flow.expense, 63_000, "1 January 2027 is not part of 2026");
  });

  it("a day in the future shows the current period, and a bad date is refused", async () => {
    assert.equal((await month("2030-01-01")).range.from, "2026-12-01");
    const bad = await c.get("/api/v1/summary?period=month&date=2026-02-30");
    assert.equal(bad.status, 400);
    assert.equal((await c.get("/api/v1/summary?period=month&date=nov")).status, 400);
  });

  it("the transaction list for a date range returns only those days", async () => {
    const list = (await c.get("/api/v1/transactions?from=2026-11-01&to=2026-11-30&limit=50")).body.items as { date: string }[];
    assert.equal(list.length, 3);
    assert.ok(list.every((r) => r.date >= "2026-11-01" && r.date <= "2026-11-30"));
  });

  it("a custom month start (the 20th) keeps cycles apart", async () => {
    assert.equal((await c.put("/api/v1/settings", { cycleStartDay: 20 })).status, 200);
    // Now is 15 December, so the current cycle is 20 Nov to 19 Dec.
    const now = await month();
    assert.deepEqual(now.range, { from: "2026-11-20", to: "2026-12-19" });
    assert.equal(now.flow.expense, 16_000 + 32_000);
    const earlier = await month("2026-11-10");
    assert.deepEqual(earlier.range, { from: "2026-10-20", to: "2026-11-19" });
    assert.equal(earlier.flow.expense, 2_000 + 4_000 + 8_000);
    assert.equal((await c.put("/api/v1/settings", { cycleStartDay: 1 })).status, 200);
  });
});
