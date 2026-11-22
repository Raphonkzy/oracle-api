import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { after, before, describe, it } from "node:test";
import { categoryId, createContext, type Client, type TestContext } from "./helpers";

describe("quick picks from your habits", () => {
  let ctx: TestContext;
  let c: Client;
  let bca: string;
  let gopay: string;
  let cash: string;
  let old: string;

  /** Sets the time of day (Jakarta) at which entries with this description were recorded. */
  const recordedAt = (like: string, hhmm: string) =>
    ctx.db.execute(sql`update transactions set created_at = ((date::text || ' ' || ${hhmm} || ':00+07')::timestamptz) where description ilike ${like} and user_id = (select id from "user" where email = 'habits@example.com')`);
  const post = async (client: Client, body: object) => assert.equal((await client.post("/api/v1/transactions", body)).status, 201);
  const items = async (kind = "expense", client: Client = c) => (await client.get(`/api/v1/suggestions?kind=${kind}`)).body.items as { description: string | null; categoryName: string | null; accountName: string; amount: number; uses: number; lastDate: string; kind: string; categoryIcon: string | null }[];
  const labels = (list: { description: string | null; categoryName: string | null }[]) => list.map((i) => i.description ?? i.categoryName);

  before(async () => {
    ctx = await createContext({ now: "2026-11-19T05:00:00Z" }); // 12:00 in Jakarta
    c = await ctx.signUp("habits@example.com");
    const mk = async (name: string, type: string) => (await c.post("/api/v1/accounts", { providerId: null, name, type, initialBalance: 10_000_000, initialBalanceDate: "2026-01-01", includeInTotal: true })).body.account.id as string;
    bca = await mk("BCA", "bank");
    gopay = await mk("GoPay", "ewallet");
    cash = await mk("Cash", "cash");
    old = await mk("Old wallet", "ewallet");
    const food = await categoryId(c, "Food & Drinks", "expense");
    const transport = await categoryId(c, "Transportation", "expense");
    const health = await categoryId(c, "Health", "expense");
    const salary = await categoryId(c, "Salary", "income");
    const e = (accountId: string, date: string, amount: number, categoryId: string | null, description: string | null) => post(c, { kind: "expense", accountId, amount, date, categoryId, description });
    // Coffee in the morning: 5 times, usually Rp 25,000. Different casing and a trailing space are the same habit.
    for (const [d, a, t] of [["2026-11-15", 25_000, "Coffee"], ["2026-11-16", 25_000, "coffee"], ["2026-11-17", 30_000, "Coffee "], ["2026-11-18", 25_000, "Coffee"], ["2026-11-19", 30_000, "COFFEE"]] as const) await e(bca, d, a, food, t);
    // Lunch at noon: 3 times.
    for (const d of ["2026-11-10", "2026-11-12", "2026-11-18"]) await e(gopay, d, 40_000, food, "Lunch");
    await e(bca, "2026-11-18", 400_000, health, "Dentist"); // once: not a habit
    for (const d of ["2026-11-17", "2026-11-18"]) await e(cash, d, 5_000, transport, null); // no description: labelled by category
    for (const d of ["2026-04-01", "2026-04-08", "2026-04-15"]) await e(bca, d, 200_000, health, "Gym"); // far too old
    for (const d of ["2026-11-01", "2026-11-02", "2026-11-03"]) await e(old, d, 9_000, food, "Old wallet snack");
    await post(c, { kind: "income", accountId: bca, amount: 5_000_000, date: "2026-10-25", categoryId: salary, description: "Salary" });
    await post(c, { kind: "income", accountId: bca, amount: 5_000_000, date: "2026-11-25".replace("25", "01"), categoryId: salary, description: "Salary" });
    for (const d of ["2026-11-14", "2026-11-18"]) await c.post("/api/v1/transfers", { fromAccountId: bca, toAccountId: gopay, amount: 100_000, fee: 2_500, date: d });
    assert.equal((await c.post(`/api/v1/accounts/${old}/archive`)).status, 200);
    // Every entry gets a fixed time of day, so the result never depends on when the test is run.
    await recordedAt("%", "18:00");
    await ctx.db.execute(sql`update transactions set created_at = ((date::text || ' 18:00:00+07')::timestamptz) where description is null and user_id = (select id from "user" where email = 'habits@example.com')`);
    await recordedAt("coffee%", "07:30");
    await recordedAt("lunch", "12:30");
  });
  after(async () => ctx.close());

  it("offers what you repeat, with the usual amount, account and category", async () => {
    const list = await items();
    const coffee = list.find((i) => i.description?.toLowerCase() === "coffee");
    assert.ok(coffee);
    assert.deepEqual([coffee.uses, coffee.amount, coffee.accountName, coffee.categoryName, coffee.categoryIcon, coffee.lastDate, coffee.kind], [5, 25_000, "BCA", "Food & Drinks", "silverware-fork-knife", "2026-11-19", "expense"]);
    const lunch = list.find((i) => i.description === "Lunch");
    assert.deepEqual([lunch?.uses, lunch?.amount, lunch?.accountName], [3, 40_000, "GoPay"]);
  });

  it("labels an entry with no description by its category", async () => {
    const parking = (await items()).find((i) => i.description === null);
    assert.deepEqual([parking?.categoryName, parking?.accountName, parking?.amount, parking?.uses], ["Transportation", "Cash", 5_000, 2]);
  });

  it("leaves out one-offs, old habits, transfers and fees, and archived accounts", async () => {
    const names = labels(await items());
    for (const gone of ["Dentist", "Gym", "Transfer fee", "Old wallet snack", "Balance adjustment"]) assert.ok(!names.includes(gone), gone);
  });

  it("keeps income and expense apart", async () => {
    assert.deepEqual(labels(await items("income")), ["Salary"]);
    assert.ok(!labels(await items("expense")).includes("Salary"));
    assert.equal((await c.get("/api/v1/suggestions")).body.items.length, (await items("expense")).length, "expense is the default");
  });

  it("puts what you usually do at this time of day first", async () => {
    ctx.clock.now = new Date("2026-11-19T05:00:00Z"); // 12:00: lunch time
    assert.equal(labels(await items())[0], "Lunch");
    ctx.clock.now = new Date("2026-11-19T00:30:00Z"); // 07:30: coffee time
    assert.equal(labels(await items())[0]?.toLowerCase(), "coffee");
    ctx.clock.now = new Date("2026-11-19T17:30:00Z"); // 00:30: neither, so the one used most comes first
    assert.equal(labels(await items())[0]?.toLowerCase(), "coffee");
    ctx.clock.now = new Date("2026-11-19T05:00:00Z");
  });

  it("stops counting after 120 days and shows at most 8", async () => {
    ctx.clock.now = new Date("2027-03-25T05:00:00Z"); // coffee and lunch are now more than 120 days old
    assert.ok(!labels(await items()).some((l) => l?.toLowerCase() === "coffee" || l === "Lunch"));
    ctx.clock.now = new Date("2026-11-19T05:00:00Z");
    const many = await ctx.signUp("eight@example.com");
    const acc = await many.post("/api/v1/accounts", { providerId: null, name: "Cash", type: "cash", initialBalance: 0, initialBalanceDate: "2026-01-01", includeInTotal: true });
    for (let i = 0; i < 12; i += 1) for (const d of ["2026-11-10", "2026-11-11"]) await post(many, { kind: "income", accountId: acc.body.account.id, amount: 1_000, date: d, categoryId: null, description: `Item ${i}` });
    assert.equal((await items("income", many)).length, 8);
  });

  it("only uses your own data, and needs a login", async () => {
    const other = await ctx.signUp("no-habits@example.com");
    assert.deepEqual(await items("expense", other), []);
    assert.equal((await ctx.anonymous.get("/api/v1/suggestions")).status, 401);
    assert.equal((await c.get("/api/v1/suggestions?kind=transfer")).status, 400);
  });
});
