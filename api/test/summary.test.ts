import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { categoryId, createContext, type Client, type TestContext } from "./helpers";

describe("summary periods", () => {
  let ctx: TestContext;
  let c: Client;
  before(async () => {
    // Thursday 19 November 2026, noon in Jakarta.
    ctx = await createContext({ now: "2026-11-19T05:00:00Z" });
    c = await ctx.signUp("periods@example.com");
    const acc = await c.post("/api/v1/accounts", { providerId: "bca", name: "myBCA", type: "bank", initialBalance: 1_000_000, initialBalanceDate: "2025-01-01", includeInTotal: true });
    const accountId = acc.body.account.id as string;
    const transport = await categoryId(c, "Transportation", "expense");
    const food = await categoryId(c, "Food & Drinks", "expense");
    const salary = await categoryId(c, "Salary", "income");
    const rows: [string, "income" | "expense", number, string | null][] = [
      ["2025-12-31", "income", 1_000, salary], // last year
      ["2026-01-01", "income", 2_000, salary], // first day of the year
      ["2026-10-31", "expense", 3_000, food], // last month
      ["2026-11-01", "income", 4_000, salary], // first day of the month
      ["2026-11-15", "expense", 5_000, null], // Sunday before this week
      ["2026-11-16", "expense", 6_000, transport], // Monday, first day of this week
      ["2026-11-19", "income", 7_000, salary], // today
      ["2026-11-22", "expense", 8_000, food], // Sunday, last day of this week
      ["2026-11-23", "expense", 9_000, transport], // Monday after this week
      ["2026-11-30", "income", 10_000, salary], // last day of the month
      ["2026-12-01", "expense", 11_000, food], // next month
    ];
    for (const [date, kind, amount, categoryId] of rows) {
      const res = await c.post("/api/v1/transactions", { kind, accountId, amount, date, categoryId });
      assert.equal(res.status, 201);
    }
  });
  after(async () => ctx.close());

  const get = async (q = "") => (await c.get(`/api/v1/summary${q}`)).body;

  it("defaults to the current month", async () => {
    const s = await get();
    assert.equal(s.period, "month");
    assert.deepEqual(s.range, { from: "2026-11-01", to: "2026-11-30" });
  });

  it("week runs Monday to Sunday and includes both edge days", async () => {
    const s = await get("?period=week");
    assert.deepEqual(s.range, { from: "2026-11-16", to: "2026-11-22" });
    assert.deepEqual(s.flow, { income: 7_000, expense: 6_000 + 8_000 });
  });

  it("month includes the first and last day, and nothing from the neighbours", async () => {
    const s = await get("?period=month");
    assert.deepEqual(s.flow, { income: 4_000 + 7_000 + 10_000, expense: 5_000 + 6_000 + 8_000 + 9_000 });
  });

  it("year runs 1 January to 31 December", async () => {
    const s = await get("?period=year");
    assert.deepEqual(s.range, { from: "2026-01-01", to: "2026-12-31" });
    assert.deepEqual(s.flow, { income: 2_000 + 4_000 + 7_000 + 10_000, expense: 3_000 + 5_000 + 6_000 + 8_000 + 9_000 + 11_000 });
  });

  it("the balance and total do not depend on the period", async () => {
    const expected = 1_000_000 + (1_000 + 2_000 + 4_000 + 7_000 + 10_000) - (3_000 + 5_000 + 6_000 + 8_000 + 9_000 + 11_000);
    for (const p of ["week", "month", "year"]) assert.equal((await get(`?period=${p}`)).total, expected);
  });

  it("spending by category follows the period, biggest first, uncategorized grouped", async () => {
    const week = (await get("?period=week")).spendingByCategory;
    assert.deepEqual(week.map((r: { name: string; amount: number }) => [r.name, r.amount]), [["Food & Drinks", 8_000], ["Transportation", 6_000]]);
    assert.ok(Math.abs(week[0].share - 8 / 14) < 1e-9);

    const month = (await get("?period=month")).spendingByCategory;
    assert.deepEqual(month.map((r: { name: string; amount: number }) => [r.name, r.amount]), [["Transportation", 15_000], ["Food & Drinks", 8_000], ["Uncategorized", 5_000]]);
    assert.equal(month[2].categoryId, null);
    assert.ok(Math.abs(month.reduce((s: number, r: { share: number }) => s + r.share, 0) - 1) < 1e-9);
  });

  it("income is not counted as spending", async () => {
    const names = (await get("?period=year")).spendingByCategory.map((r: { name: string }) => r.name);
    assert.ok(!names.includes("Salary"));
  });

  it("a period with no activity returns zeros, not errors", async () => {
    ctx.clock.now = new Date("2030-06-15T05:00:00Z");
    const s = await get("?period=week");
    assert.deepEqual([s.flow, s.spendingByCategory], [{ income: 0, expense: 0 }, []]);
    ctx.clock.now = new Date("2026-11-19T05:00:00Z");
  });

  it("Jakarta time decides the day: 23:30 UTC on the 18th is already the 19th in Jakarta", async () => {
    ctx.clock.now = new Date("2026-11-22T20:00:00Z"); // 23 Nov 03:00 in Jakarta: next week
    assert.deepEqual((await get("?period=week")).range, { from: "2026-11-23", to: "2026-11-29" });
    ctx.clock.now = new Date("2026-11-30T17:30:00Z"); // 1 Dec 00:30 in Jakarta: next month
    assert.deepEqual((await get("?period=month")).range, { from: "2026-12-01", to: "2026-12-31" });
    ctx.clock.now = new Date("2026-11-19T05:00:00Z");
  });

  it("rejects an unknown period", async () => {
    const res = await c.get("/api/v1/summary?period=decade");
    assert.deepEqual([res.status, res.body.error.code], [400, "validation"]);
  });
});
