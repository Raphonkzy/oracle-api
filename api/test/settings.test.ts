import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { categoryId, createContext, type Client, type TestContext } from "./helpers";

describe("pay cycle settings", () => {
  let ctx: TestContext;
  let c: Client;
  let accountId = "";
  before(async () => {
    // Sunday 29 November 2026, noon in Jakarta. With a cycle starting on the 20th, this is day 10 of the cycle that began on 20 November.
    ctx = await createContext({ now: "2026-11-29T05:00:00Z" });
    c = await ctx.signUp("cycle@example.com");
    const acc = await c.post("/api/v1/accounts", { providerId: "bca", name: "myBCA", type: "bank", initialBalance: 1_000_000, initialBalanceDate: "2025-01-01", includeInTotal: true });
    accountId = acc.body.account.id as string;
    const food = await categoryId(c, "Food & Drinks", "expense");
    for (const [date, amount] of [["2026-11-05", 1_000], ["2026-11-19", 2_000], ["2026-11-20", 4_000], ["2026-11-29", 8_000], ["2026-12-19", 16_000], ["2026-12-20", 32_000]] as const) {
      const res = await c.post("/api/v1/transactions", { kind: "expense", accountId, amount, date, categoryId: food });
      assert.equal(res.status, 201);
    }
  });
  after(async () => ctx.close());

  it("starts as the calendar month", async () => {
    assert.deepEqual((await c.get("/api/v1/settings")).body, { cycleStartDay: 1 });
    const s = (await c.get("/api/v1/summary?period=month")).body;
    assert.deepEqual(s.range, { from: "2026-11-01", to: "2026-11-30" });
    assert.equal(s.flow.expense, 15_000);
  });

  it("changes what a month means everywhere once chosen", async () => {
    const put = await c.put("/api/v1/settings", { cycleStartDay: 20 });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body, { cycleStartDay: 20 });
    assert.deepEqual((await c.get("/api/v1/settings")).body, { cycleStartDay: 20 });
    const s = (await c.get("/api/v1/summary?period=month")).body;
    assert.deepEqual(s.range, { from: "2026-11-20", to: "2026-12-19" });
    assert.equal(s.flow.expense, 4_000 + 8_000 + 16_000);
    const flow = (await c.get("/api/v1/stats/flow?period=month")).body;
    assert.equal(flow.total, 28_000);
    assert.equal(flow.buckets[0].from, "2026-11-20");
    assert.equal(flow.buckets.at(-1).to, "2026-12-19");
    // The same days of the cycle before: 20 to 29 October.
    assert.deepEqual((await c.get("/api/v1/stats/categories?period=month")).body.range, { from: "2026-11-20", to: "2026-12-19" });
  });

  it("budgets follow the cycle and default to the current one", async () => {
    const food = await categoryId(c, "Food & Drinks", "expense");
    const put = await c.put("/api/v1/budgets/2026-11", { items: [{ categoryId: food, amount: 100_000 }] });
    assert.equal(put.status, 200);
    assert.equal(put.body.spent, 28_000);
    const current = (await c.get("/api/v1/budgets")).body;
    assert.equal(current.month, "2026-11");
    assert.equal(current.spent, 28_000);
  });

  it("people do not see each other's setting", async () => {
    const other = await ctx.signUp("cycle2@example.com");
    assert.deepEqual((await other.get("/api/v1/settings")).body, { cycleStartDay: 1 });
  });

  it("refuses values that are not a day from 1 to 28", async () => {
    for (const bad of [0, 29, -1, 1.5, "20", null]) {
      const res = await c.put("/api/v1/settings", { cycleStartDay: bad });
      assert.equal(res.status, 400, JSON.stringify(bad));
    }
    assert.equal((await c.put("/api/v1/settings", { cycleStartDay: 20, other: 1 })).status, 400);
    assert.equal((await c.put("/api/v1/settings", {})).status, 400);
    assert.deepEqual((await c.get("/api/v1/settings")).body, { cycleStartDay: 20 });
  });

  it("can go back to the calendar month", async () => {
    await c.put("/api/v1/settings", { cycleStartDay: 1 });
    assert.deepEqual((await c.get("/api/v1/summary?period=month")).body.range, { from: "2026-11-01", to: "2026-11-30" });
  });

  it("needs a login", async () => {
    assert.equal((await ctx.anonymous.get("/api/v1/settings")).status, 401);
  });

  it("words the insights in the app language and refuses a language it does not have", async () => {
    const id = await c.get("/api/v1/insights?period=month&language=id");
    assert.equal(id.status, 200);
    assert.ok(id.body.items.length > 0);
    assert.ok(!/ this month| spent/.test(id.body.items.map((i: { text: string }) => i.text).join(" ")), "no English words left");
    assert.equal((await c.get("/api/v1/insights?period=month&language=xx")).status, 400);
  });
});
