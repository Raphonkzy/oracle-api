import assert from "node:assert/strict";
import { formatRupiah } from "@oracle/core";
import { after, before, describe, it } from "node:test";
import { categoryId, createContext, type Client, type TestContext } from "./helpers";

const Rp = formatRupiah;

describe("budgets, statistics, insights and categories", () => {
  let ctx: TestContext;
  let c: Client;
  let accA: string;
  let accB: string;
  let food: string;
  let shopping: string;
  let transport: string;
  let salary: string;

  before(async () => {
    // Thursday 19 November 2026. This week is 16-22 Nov. Last week "so far" is 9-12 Nov. Last month "so far" is 1-19 Oct.
    ctx = await createContext({ now: "2026-11-19T05:00:00Z" });
    c = await ctx.signUp("analysis@example.com");
    const a = await c.post("/api/v1/accounts", { providerId: "bca", name: "myBCA", type: "bank", initialBalance: 5_000_000, initialBalanceDate: "2026-11-01", includeInTotal: true });
    const b = await c.post("/api/v1/accounts", { providerId: "gopay", name: "GoPay", type: "ewallet", initialBalance: 1_000_000, initialBalanceDate: "2026-11-01", includeInTotal: true });
    accA = a.body.account.id;
    accB = b.body.account.id;
    food = await categoryId(c, "Food & Drinks", "expense");
    shopping = await categoryId(c, "Shopping", "expense");
    transport = await categoryId(c, "Transportation", "expense");
    salary = await categoryId(c, "Salary", "income");
    const rows: [string, "income" | "expense", number, string, string | null][] = [
      ["2026-10-05", "expense", 100_000, food, null],
      ["2026-10-18", "expense", 100_000, food, null],
      ["2026-10-25", "expense", 500_000, shopping, null], // after the "so far" window of last month
      ["2026-11-01", "income", 1_000_000, salary, null],
      ["2026-11-03", "expense", 150_000, food, null],
      ["2026-11-10", "expense", 50_000, transport, null],
      ["2026-11-11", "expense", 60_000, food, null],
      ["2026-11-16", "expense", 120_000, food, "Groceries"],
      ["2026-11-17", "expense", 80_000, shopping, null],
      ["2026-11-19", "expense", 40_000, food, null],
    ];
    for (const [date, kind, amount, categoryId, description] of rows) {
      const res = await c.post("/api/v1/transactions", { kind, accountId: accA, amount, date, categoryId, description });
      assert.equal(res.status, 201, JSON.stringify(res.body));
    }
    const tr = await c.post("/api/v1/transfers", { fromAccountId: accA, toAccountId: accB, amount: 100_000, fee: 2_500, date: "2026-11-18" });
    assert.equal(tr.status, 201);
    // GoPay was checked against the real app yesterday, so only myBCA counts as stale.
    const check = await c.post(`/api/v1/accounts/${accB}/balance-checks`, { actualBalance: 1_100_000, date: "2026-11-18" });
    assert.equal(check.status, 201, JSON.stringify(check.body));
  });
  after(async () => ctx.close());

  describe("statistics", () => {
    it("week: one bar per day, and the change compares with the same days of last week", async () => {
      const r = await c.get("/api/v1/stats/flow?period=week");
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.range, { from: "2026-11-16", to: "2026-11-22" });
      assert.deepEqual(r.body.buckets.map((b: { label: string; amount: number }) => [b.label, b.amount]), [
        ["Mon", 120_000], ["Tue", 80_000], ["Wed", 2_500], ["Thu", 40_000], ["Fri", 0], ["Sat", 0], ["Sun", 0],
      ]);
      assert.deepEqual(r.body.buckets.map((b: { current: boolean }) => b.current), [false, false, false, true, false, false, false]);
      assert.equal(r.body.total, 242_500);
      assert.equal(r.body.previousTotal, 110_000);
      assert.equal(r.body.changePct, 120);
    });
    it("month: Monday-to-Sunday weeks clipped to the month", async () => {
      const r = await c.get("/api/v1/stats/flow?period=month");
      assert.deepEqual(r.body.buckets.map((b: { label: string; from: string; to: string; amount: number }) => [b.label, b.from, b.to, b.amount]), [
        ["W1", "2026-11-01", "2026-11-01", 0],
        ["W2", "2026-11-02", "2026-11-08", 150_000],
        ["W3", "2026-11-09", "2026-11-15", 110_000],
        ["W4", "2026-11-16", "2026-11-22", 242_500],
        ["W5", "2026-11-23", "2026-11-29", 0],
        ["W6", "2026-11-30", "2026-11-30", 0],
      ]);
      assert.equal(r.body.total, 502_500);
      assert.equal(r.body.previousTotal, 200_000);
      assert.equal(r.body.changePct, 151);
    });
    it("year: one bar per month, and no change when last year is empty", async () => {
      const r = await c.get("/api/v1/stats/flow?period=year");
      assert.equal(r.body.buckets.length, 12);
      const byLabel = Object.fromEntries(r.body.buckets.map((b: { label: string; amount: number }) => [b.label, b.amount]));
      assert.deepEqual([byLabel.Oct, byLabel.Nov, byLabel.Dec], [700_000, 502_500, 0]);
      assert.equal(r.body.total, 1_202_500);
      assert.deepEqual([r.body.previousTotal, r.body.changePct], [0, null]);
    });
    it("categories: amounts, shares and the change against last week", async () => {
      const r = await c.get("/api/v1/stats/categories?period=week");
      assert.deepEqual(r.body.items.map((i: { name: string; amount: number; previousAmount: number; changePct: number | null }) => [i.name, i.amount, i.previousAmount, i.changePct]), [
        ["Food & Drinks", 160_000, 60_000, 167],
        ["Shopping", 80_000, 0, null],
        ["Financial & Fees", 2_500, 0, null],
      ]);
      assert.equal(r.body.total, 242_500);
      assert.ok(Math.abs(r.body.items[0].share - 160_000 / 242_500) < 1e-9);
    });
    it("rejects a bad period", async () => {
      assert.equal((await c.get("/api/v1/stats/flow?period=decade")).status, 400);
      assert.equal((await c.get("/api/v1/stats/categories?period=x")).status, 400);
    });
  });

  describe("budgets", () => {
    it("starts empty and shows what was spent without a budget", async () => {
      const r = await c.get("/api/v1/budgets?month=2026-11");
      assert.deepEqual([r.status, r.body.items, r.body.budget, r.body.spent], [200, [], 0, 0]);
      assert.equal(r.body.unbudgetedSpent, 502_500);
    });
    it("sets all budgets of a month and reports spent and left", async () => {
      const put = await c.call("PUT", "/api/v1/budgets/2026-11", { items: [{ categoryId: food, amount: 400_000 }, { categoryId: shopping, amount: 50_000 }, { categoryId: transport, amount: 500_000 }] });
      assert.equal(put.status, 200, JSON.stringify(put.body));
      assert.deepEqual([put.body.budget, put.body.spent, put.body.left, put.body.unbudgetedSpent], [950_000, 500_000, 450_000, 2_500]);
      const byName = Object.fromEntries(put.body.items.map((i: { name: string; budget: number; spent: number }) => [i.name, [i.budget, i.spent]]));
      assert.deepEqual(byName, { "Food & Drinks": [400_000, 370_000], Shopping: [50_000, 80_000], Transportation: [500_000, 50_000] });
      assert.deepEqual((await c.get("/api/v1/budgets?month=2026-11")).body.budget, 950_000);
    });
    it("defaults to the current month", async () => {
      assert.equal((await c.get("/api/v1/budgets")).body.month, "2026-11");
    });
    it("replaces the whole month, and an empty list clears it", async () => {
      await c.call("PUT", "/api/v1/budgets/2026-09", { items: [{ categoryId: food, amount: 1_000 }] });
      const again = await c.call("PUT", "/api/v1/budgets/2026-09", { items: [{ categoryId: shopping, amount: 2_000 }] });
      assert.deepEqual(again.body.items.map((i: { name: string }) => i.name), ["Shopping"]);
      assert.deepEqual((await c.call("PUT", "/api/v1/budgets/2026-09", { items: [] })).body.items, []);
    });
    it("copies last month's budgets and never overwrites an existing one", async () => {
      await c.call("PUT", "/api/v1/budgets/2026-12", { items: [{ categoryId: food, amount: 123_000 }] });
      const r = await c.post("/api/v1/budgets/2026-12/copy-previous");
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.copied, 2);
      const byName = Object.fromEntries(r.body.items.map((i: { name: string; budget: number }) => [i.name, i.budget]));
      assert.deepEqual(byName, { "Food & Drinks": 123_000, Shopping: 50_000, Transportation: 500_000 });
      assert.equal((await c.post("/api/v1/budgets/2026-12/copy-previous")).body.copied, 0);
      assert.deepEqual((await c.post("/api/v1/budgets/2027-03/copy-previous")).body.copied, 0);
    });
    it("rejects bad input with a 400", async () => {
      const bad: [string, unknown][] = [
        ["income category", { items: [{ categoryId: salary, amount: 1_000 }] }],
        ["duplicate category", { items: [{ categoryId: food, amount: 1_000 }, { categoryId: food, amount: 2_000 }] }],
        ["zero amount", { items: [{ categoryId: food, amount: 0 }] }],
        ["fraction", { items: [{ categoryId: food, amount: 10.5 }] }],
        ["not a category", { items: [{ categoryId: "nope", amount: 1_000 }] }],
        ["missing list", {}],
      ];
      for (const [label, body] of bad) assert.equal((await c.call("PUT", "/api/v1/budgets/2026-11", body)).status, 400, label);
      assert.equal((await c.call("PUT", "/api/v1/budgets/2026-13", { items: [] })).status, 400);
      assert.equal((await c.post("/api/v1/budgets/nope/copy-previous")).status, 400);
      assert.equal((await c.get("/api/v1/budgets?month=2026-1")).status, 400);
      assert.equal((await c.get("/api/v1/budgets?month=2026-11")).body.budget, 950_000, "a rejected request changed nothing");
    });
    it("keeps users apart", async () => {
      const other = await ctx.signUp("other-budgets@example.com");
      assert.deepEqual((await other.get("/api/v1/budgets?month=2026-11")).body.items, []);
      const res = await other.call("PUT", "/api/v1/budgets/2026-11", { items: [{ categoryId: food, amount: 5_000 }] });
      assert.equal(res.status, 400, "another user's category cannot be budgeted");
      assert.equal((await c.get("/api/v1/budgets?month=2026-11")).body.budget, 950_000);
    });
  });

  describe("insights", () => {
    it("explains the week with the numbers it used, warnings first", async () => {
      const r = await c.get("/api/v1/insights?period=week");
      assert.equal(r.status, 200);
      const items = r.body.items as { id: string; kind: string; tone: string; text: string }[];
      assert.deepEqual(items.map((i) => i.id), [`budget-over-${shopping}`, `budget-near-${food}`, `trend-${food}`, "peak", "fees", "stale-myBCA"]);
      assert.deepEqual(items.map((i) => i.tone), ["alert", "warn", "warn", "info", "info", "info"]);
      assert.equal(items[0].text, `Your Shopping budget is ${Rp(30_000)} over this month (${Rp(80_000)} of ${Rp(50_000)}, 160% used).`);
      assert.equal(items[1].text, `Food & Drinks is at 93% of its budget this month (${Rp(370_000)} of ${Rp(400_000)}). ${Rp(30_000)} left.`);
      assert.equal(items[2].text, `Food & Drinks this week: ${Rp(160_000)}, up 167% from last week (${Rp(60_000)}).`);
      assert.equal(items[3].text, `Biggest single expense this week: ${Rp(120_000)} (Groceries, Food & Drinks).`);
      assert.equal(items[4].text, "Fees paid this week: " + Rp(2_500) + " across 1 transfer.");
      assert.equal(items[5].text, "myBCA balance not updated for 18 days. Check it against the real app.");
    });
    it("says so when there is nothing to analyze", async () => {
      const fresh = await ctx.signUp("fresh-insights@example.com");
      const r = await fresh.get("/api/v1/insights?period=week");
      assert.deepEqual(r.body.items.map((i: { id: string }) => i.id), ["empty"]);
    });
    it("rejects a bad period", async () => {
      assert.equal((await c.get("/api/v1/insights?period=soon")).status, 400);
    });
  });

  describe("categories", () => {
    it("lists icons and colors", async () => {
      const cats = (await c.get("/api/v1/categories")).body.categories as { name: string; icon: string | null; color: string | null }[];
      assert.equal(cats.find((x) => x.name === "Transportation")?.icon, "car");
      assert.ok(cats.every((x) => x.color));
    });
    it("renames a category and changes its icon", async () => {
      const r = await c.patch(`/api/v1/categories/${transport}`, { name: "Commute", icon: "bank" });
      assert.deepEqual([r.status, r.body.category.name, r.body.category.icon], [200, "Commute", "bank"]);
      const past = await c.get("/api/v1/transactions?q=Commute");
      assert.ok(past.body.items.length > 0, "old transactions follow the new name");
      assert.equal((await c.patch(`/api/v1/categories/${transport}`, { name: "Transportation" })).status, 200);
    });
    it("rejects a duplicate name, a bad icon, an empty change and the fee category", async () => {
      assert.equal((await c.patch(`/api/v1/categories/${transport}`, { name: "Shopping" })).body.error.code, "duplicate_category");
      assert.equal((await c.patch(`/api/v1/categories/${transport}`, { icon: "skull" })).status, 400);
      assert.equal((await c.patch(`/api/v1/categories/${transport}`, {})).status, 400);
      assert.equal((await c.patch(`/api/v1/categories/${transport}`, { name: "   " })).status, 400);
      const fee = await categoryId(c, "Financial & Fees", "expense");
      assert.equal((await c.patch(`/api/v1/categories/${fee}`, { name: "Fees" })).body.error.code, "category_locked");
      assert.equal((await c.patch(`/api/v1/categories/${fee}`, { icon: "bank" })).status, 200, "its icon can still change");
    });
    it("never touches another user's category", async () => {
      const other = await ctx.signUp("other-categories@example.com");
      assert.equal((await other.patch(`/api/v1/categories/${transport}`, { name: "Mine now" })).status, 404);
      assert.equal((await other.patch("/api/v1/categories/not-a-uuid", { name: "x" })).status, 404);
      assert.equal(await categoryId(c, "Transportation", "expense"), transport);
    });
    it("needs a login", async () => {
      for (const [m, p] of [["GET", "/api/v1/budgets"], ["PUT", "/api/v1/budgets/2026-11"], ["GET", "/api/v1/stats/flow"], ["GET", "/api/v1/insights"], ["PATCH", `/api/v1/categories/${transport}`]]) {
        assert.equal((await ctx.anonymous.call(m, p, m === "GET" ? undefined : {})).status, 401, `${m} ${p}`);
      }
    });
  });
});
