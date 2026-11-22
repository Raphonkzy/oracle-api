import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { buildDevData, runDevData, ACCOUNTS } from "../src/cli/dev-data";
import { createContext, type Client, type TestContext } from "./helpers";

describe("two years of data for the developer account", () => {
  let ctx: TestContext;
  let dev: Client;
  const today = "2026-11-22";

  before(async () => {
    ctx = await createContext({ now: "2026-11-22T05:00:00Z" });
    dev = await ctx.signUp("dev@example.com", "Developer");
  });
  after(async () => ctx.close());

  it("is the same every time and starts two years back", () => {
    const a = buildDevData(today);
    const b = buildDevData(today);
    assert.deepEqual(a.steps, b.steps);
    assert.equal(a.start, "2024-11-01");
    assert.ok(a.steps.length > 1_500, `${a.steps.length} steps`);
  });

  it("a full run makes two years: a closed account, a raise and hundreds of budgets rows", () => {
    const full = buildDevData(today);
    assert.ok(full.steps.some((s) => s.kind === "archive"));
    assert.equal(full.steps.filter((s) => s.kind === "budgets").length, 25);
    const salaries = full.steps.filter((s) => s.kind === "tx" && s.category === "Salary").map((s) => (s.kind === "tx" ? s.amount : 0));
    assert.deepEqual([salaries[0], salaries[salaries.length - 1]], [9_500_000, 10_500_000]);
  });

  it("the server accepts every step, so no account is ever overdrawn", async () => {
    // Four months keep the test quick; the same code makes the full two years.
    const result = await runDevData((method, path, body) => dev.call(method, path, body), today, undefined, 4);
    assert.equal(result.accounts, ACCOUNTS.length);
    assert.ok(result.transactions > 250 && result.transfers > 20, JSON.stringify(result));
  });

  it("looks like a real life: balances stay in order, every month has income and spending, budgets exist", async () => {
    const accounts = (await dev.get("/api/v1/accounts?archived=false")).body.accounts as { name: string; type: string; balance: number }[];
    for (const a of accounts) if (a.type !== "paylater" && a.type !== "credit_card") assert.ok(a.balance >= 0, `${a.name} ${a.balance}`);
    const archived = (await dev.get("/api/v1/accounts?archived=true")).body.accounts as { name: string }[];
    // DANA is closed on 3 November 2025, which is outside these four months, so it is still open here.
    assert.deepEqual(archived, []);
    const trend = (await dev.get("/api/v1/stats/trend?months=4")).body.months as { month: string; income: number; expense: number }[];
    assert.equal(trend.length, 4);
    for (const m of trend.slice(0, -1)) {
      assert.ok(m.income > 8_000_000 && m.expense > 2_000_000, `${m.month} ${m.income} ${m.expense}`);
    }
    const budgets = (await dev.get("/api/v1/budgets?month=2026-10")).body;
    assert.ok(budgets.items.length >= 6 && budgets.spent > 0);
    const total = (await dev.get("/api/v1/summary?period=month")).body.total as number;
    assert.equal(total, accounts.reduce((s, a) => s + a.balance, 0));
    assert.ok(total > 0, `total ${total}`);
  });
});
