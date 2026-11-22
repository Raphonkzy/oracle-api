import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { categoryId, createContext, type Client, type TestContext } from "./helpers";

describe("trend and details for the charts", () => {
  let ctx: TestContext;
  let c: Client;
  let bca: string;
  let gopay: string;
  let food: string;
  const put = async (kind: "income" | "expense", date: string, amount: number, description: string) => {
    const res = await c.post("/api/v1/transactions", { kind, accountId: bca, amount, date, categoryId: kind === "expense" ? food : null, description });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  };

  before(async () => {
    ctx = await createContext({ now: "2026-12-15T05:00:00Z" });
    c = await ctx.signUp("trend@example.com");
    bca = (await c.post("/api/v1/accounts", { providerId: null, name: "BCA", type: "bank", initialBalance: 100_000_000, initialBalanceDate: "2026-01-01", includeInTotal: true })).body.account.id;
    gopay = (await c.post("/api/v1/accounts", { providerId: null, name: "GoPay", type: "ewallet", initialBalance: 1_000_000, initialBalanceDate: "2026-01-01", includeInTotal: true })).body.account.id;
    food = await categoryId(c, "Food & Drinks", "expense");
    await put("income", "2026-10-01", 5_000_000, "Pay Oct");
    await put("expense", "2026-10-31", 2_000, "Oct 31");
    await put("expense", "2026-11-01", 4_000, "Nov 1");
    await put("income", "2026-11-01", 6_000_000, "Pay Nov");
    await put("expense", "2026-11-15", 8_000, "Nov 15");
    await put("expense", "2026-12-01", 30_000, "Dec 1");
    await put("expense", "2026-12-10", 60_000, "Dec 10");
    // A transfer with a fee: the amount is neither income nor expense, the fee is an expense.
    assert.equal((await c.post("/api/v1/transfers", { fromAccountId: bca, toAccountId: gopay, amount: 500_000, fee: 2_500, date: "2026-12-05" })).status, 201);
  });
  after(async () => ctx.close());

  describe("GET /stats/trend", () => {
    it("lists the months oldest first and ends with the current one", async () => {
      const r = await c.get("/api/v1/stats/trend?months=3");
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.months.map((m: { month: string }) => m.month), ["2026-10", "2026-11", "2026-12"]);
      const [oct, nov, dec] = r.body.months;
      assert.deepEqual([oct.income, oct.expense, oct.net], [5_000_000, 2_000, 4_998_000]);
      assert.deepEqual([nov.income, nov.expense], [6_000_000, 12_000]);
      assert.deepEqual([dec.income, dec.expense], [0, 30_000 + 60_000 + 2_500], "the fee counts, the transfer does not");
      assert.deepEqual({ from: nov.from, to: nov.to }, { from: "2026-11-01", to: "2026-11-30" });
    });

    it("October stays out of November and November out of December", async () => {
      const r = await c.get("/api/v1/stats/trend?months=1&date=2026-11-30");
      assert.equal(r.body.months.length, 1);
      assert.equal(r.body.months[0].expense, 12_000);
      const oct = await c.get("/api/v1/stats/trend?months=1&date=2026-10-31");
      assert.equal(oct.body.months[0].expense, 2_000);
    });

    it("across the year change, and defaults to six months", async () => {
      const r = await c.get("/api/v1/stats/trend");
      assert.equal(r.body.months.length, 6);
      assert.deepEqual(r.body.months.map((m: { month: string }) => m.month), ["2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12"]);
      const early = await c.get("/api/v1/stats/trend?months=3&date=2026-01-10");
      assert.deepEqual(early.body.months.map((m: { month: string }) => m.month), ["2025-11", "2025-12", "2026-01"]);
    });

    it("follows a pay cycle that starts on the 20th", async () => {
      assert.equal((await c.put("/api/v1/settings", { cycleStartDay: 20 })).status, 200);
      const r = await c.get("/api/v1/stats/trend?months=2");
      const [prev, cur] = r.body.months;
      assert.deepEqual({ from: prev.from, to: prev.to }, { from: "2026-10-20", to: "2026-11-19" });
      assert.equal(prev.expense, 2_000 + 4_000 + 8_000, "31 Oct, 1 Nov and 15 Nov are one cycle");
      assert.deepEqual({ from: cur.from, to: cur.to }, { from: "2026-11-20", to: "2026-12-19" });
      assert.equal(cur.expense, 92_500);
      assert.equal((await c.put("/api/v1/settings", { cycleStartDay: 1 })).status, 200);
    });

    it("refuses bad input", async () => {
      for (const q of ["months=0", "months=13", "months=abc", "months=2.5", "date=2026-02-30"]) assert.equal((await c.get(`/api/v1/stats/trend?${q}`)).status, 400, q);
    });
  });

  describe("GET /stats/details", () => {
    it("gives every day, the totals and the biggest expenses of the current month", async () => {
      const r = await c.get("/api/v1/stats/details?period=month");
      assert.equal(r.status, 200);
      const d = r.body;
      assert.deepEqual(d.range, { from: "2026-12-01", to: "2026-12-31" });
      assert.equal(d.isCurrent, true);
      assert.equal(d.days.length, 31);
      assert.deepEqual(d.totals, { income: 0, expense: 92_500, net: -92_500, count: 3 });
      assert.equal(d.days.reduce((s: number, x: { expense: number }) => s + x.expense, 0), d.totals.expense, "the days add up to the total");
      assert.equal(d.avgDailyExpense, Math.round(92_500 / 15));
      assert.deepEqual(d.projection, { expense: Math.round((92_500 / 15) * 31), daysLeft: 16 });
      assert.deepEqual(d.biggest.map((x: { amount: number }) => Math.abs(x.amount)), [60_000, 30_000, 2_500]);
    });

    it("a finished month is complete, with no projection", async () => {
      const r = await c.get("/api/v1/stats/details?period=month&date=2026-11-10");
      assert.equal(r.body.isCurrent, false);
      assert.deepEqual(r.body.range, { from: "2026-11-01", to: "2026-11-30" });
      assert.equal(r.body.projection, null);
      assert.equal(r.body.avgDailyExpense, Math.round(12_000 / 30));
      assert.deepEqual(r.body.totals, { income: 6_000_000, expense: 12_000, net: 5_988_000, count: 3 });
    });

    it("a year has no projection and every day of it", async () => {
      const r = await c.get("/api/v1/stats/details?period=year");
      assert.equal(r.body.days.length, 365);
      assert.equal(r.body.projection, null);
      assert.equal(r.body.totals.income, 11_000_000);
    });

    it("transfers are in neither income nor expense", async () => {
      const r = await c.get("/api/v1/stats/details?period=week&date=2026-12-05");
      assert.deepEqual(r.body.range, { from: "2026-11-30", to: "2026-12-06" });
      assert.equal(r.body.totals.expense, 30_000 + 2_500, "Dec 1 and the fee, not the Rp 500,000");
      assert.equal(r.body.totals.income, 0);
    });

    it("sees only its own data, needs a login, and refuses bad input", async () => {
      const other = await ctx.signUp("trend2@example.com");
      const r = await other.get("/api/v1/stats/details?period=month&date=2026-11-10");
      assert.deepEqual([r.body.totals.expense, r.body.totals.count, r.body.biggest.length], [0, 0, 0]);
      assert.equal((await other.get("/api/v1/stats/trend?months=3")).body.months.every((m: { income: number; expense: number }) => m.income === 0 && m.expense === 0), true);
      assert.equal((await ctx.anonymous.get("/api/v1/stats/details?period=month")).status, 401);
      assert.equal((await ctx.anonymous.get("/api/v1/stats/trend")).status, 401);
      assert.equal((await c.get("/api/v1/stats/details?period=decade")).status, 400);
      assert.equal((await c.get("/api/v1/stats/details?period=month&date=nope")).status, 400);
    });
  });
});
