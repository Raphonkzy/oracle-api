import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LANGUAGES, TRANSLATED_CATEGORY_NAMES, localCategoryName } from "@oracle/core";
import { CATEGORY_ICONS } from "@oracle/core";
import { DEFAULT_CATEGORIES } from "@oracle/db/seed/categories";
import { sql } from "drizzle-orm";
import { after, before, describe, it } from "node:test";
import { categoryId, createContext, type Client, type TestContext } from "./helpers";

const MIGRATION = readFileSync(new URL("../../db/drizzle/0003_default_categories.sql", import.meta.url), "utf8");
const runMigration = async (ctx: TestContext) => {
  for (const part of MIGRATION.split("--> statement-breakpoint")) await ctx.db.execute(sql.raw(part));
};
const names = async (ctx: TestContext, email: string, kind: string, archived = false) =>
  (
    (await ctx.db.execute(sql`select c.name, c.archived_at is not null as archived from categories c join "user" u on u.id = c.user_id where u.email = ${email} and c.kind::text = ${kind} order by c.sort_order, c.name`)) as unknown as { name: string; archived: boolean }[]
  )
    .filter((r) => r.archived === archived)
    .map((r) => r.name);

describe("default categories", () => {
  it("are the 15 expense and 12 income categories, in this order, with valid icons", () => {
    assert.deepEqual(
      DEFAULT_CATEGORIES.filter((c) => c.kind === "expense").map((c) => c.name),
      ["Food & Drinks", "Transportation", "Shopping", "Bills & Utilities", "Housing", "Entertainment", "Health", "Personal Care", "Education", "Family & Kids", "Travel", "Financial & Fees", "Insurance", "Charity", "Subscriptions"],
    );
    assert.deepEqual(
      DEFAULT_CATEGORIES.filter((c) => c.kind === "income").map((c) => c.name),
      ["Salary", "Bonus", "Freelance", "Business Income", "Investment Income", "Interest", "Gifts", "Cashback & Rewards", "Rental Income", "Allowance", "Refund", "Other Income"],
    );
    for (const c of DEFAULT_CATEGORIES) assert.ok((CATEGORY_ICONS as readonly string[]).includes(c.icon), `${c.name}: ${c.icon}`);
    assert.equal(new Set(DEFAULT_CATEGORIES.map((c) => `${c.kind}:${c.name}`)).size, DEFAULT_CATEGORIES.length, "no duplicates");
  });

  it("every one is written in every language", () => {
    for (const c of DEFAULT_CATEGORIES) {
      assert.ok(TRANSLATED_CATEGORY_NAMES.includes(c.name), `${c.name} has no translation`);
      for (const l of LANGUAGES) assert.ok(localCategoryName(c.name, l.code).trim().length > 0, `${c.name} in ${l.code}`);
    }
    assert.equal(localCategoryName("Food & Drinks", "id"), "Makanan & Minuman");
    assert.equal(localCategoryName("Food & Drinks", "en"), "Food & Drinks");
  });

  it("leave a name the person made or changed exactly as typed", () => {
    for (const l of LANGUAGES) assert.equal(localCategoryName("My Pets", l.code), "My Pets");
    // Names that are inherited from Object.prototype must not be mistaken for a translation.
    assert.equal(localCategoryName("constructor", "id"), "constructor");
    assert.equal(localCategoryName("__proto__", "de"), "__proto__");
  });
});

describe("moving an existing account to the new defaults", () => {
  let ctx: TestContext;
  let old: Client;
  before(async () => {
    ctx = await createContext();
    old = await ctx.signUp("old@example.com", "Old");
    // Put this account back into what the first versions of the app created.
    await ctx.db.execute(sql`
      update categories set name = case name
        when 'Transportation' then 'Transport' when 'Housing' then 'Home' when 'Family & Kids' then 'Family'
        when 'Financial & Fees' then 'Admin Fee' when 'Cashback & Rewards' then 'Cashback' else name end
      where user_id = (select id from "user" where email = 'old@example.com')`);
    await ctx.db.execute(sql`
      delete from categories where user_id = (select id from "user" where email = 'old@example.com')
        and name in ('Personal Care','Travel','Insurance','Business Income','Investment Income','Interest','Rental Income','Allowance','Refund','Other Income')`);
    await old.post("/api/v1/categories", { name: "Pets", kind: "expense", icon: "paw" });
    // The first versions also made "Phone & Internet". One account never used it, another one did.
    await ctx.db.execute(sql`insert into categories (user_id, name, kind, sort_order) select id, 'Phone & Internet', 'expense', 40 from "user" where email = 'old@example.com'`);
  });
  after(async () => ctx.close());

  it("renames the old names, keeps history, adds the missing ones, and leaves the person's own alone", async () => {
    const transport = await categoryId(old, "Transport", "expense");
    const acc = (await old.post("/api/v1/accounts", { providerId: null, name: "Cash", type: "cash", initialBalance: 100_000, initialBalanceDate: "2026-11-01", includeInTotal: true })).body.account.id as string;
    await old.post("/api/v1/transactions", { kind: "expense", accountId: acc, amount: 5_000, date: "2026-11-10", categoryId: transport });

    await runMigration(ctx);

    const expense = await names(ctx, "old@example.com", "expense");
    for (const n of ["Transportation", "Housing", "Family & Kids", "Financial & Fees", "Personal Care", "Travel", "Insurance", "Pets", "Food & Drinks", "Subscriptions"]) assert.ok(expense.includes(n), `missing ${n}: ${expense.join(", ")}`);
    for (const n of ["Transport", "Home", "Family", "Admin Fee"]) assert.ok(!expense.includes(n), `${n} should be renamed`);
    const income = await names(ctx, "old@example.com", "income");
    for (const n of ["Cashback & Rewards", "Business Income", "Investment Income", "Interest", "Rental Income", "Allowance", "Refund", "Other Income", "Salary"]) assert.ok(income.includes(n), `missing ${n}`);
    // The same category, now with the new name: the transaction still points at it.
    assert.equal(await categoryId(old, "Transportation", "expense"), transport);
    const rows = (await old.get("/api/v1/transactions")).body.items as { categoryName: string }[];
    assert.equal(rows[0].categoryName, "Transportation");
  });

  it("hides the old Phone & Internet only when nothing uses it", async () => {
    // "old@" never used it: hidden. "used@" recorded money under it: still there.
    assert.ok(!(await names(ctx, "old@example.com", "expense")).includes("Phone & Internet"));
    assert.ok((await names(ctx, "old@example.com", "expense", true)).includes("Phone & Internet"), "hidden, not deleted");
    const used = await ctx.signUp("used@example.com", "Used");
    await ctx.db.execute(sql`insert into categories (user_id, name, kind, sort_order) select id, 'Phone & Internet', 'expense', 40 from "user" where email = 'used@example.com'`);
    const phone = await categoryId(used, "Phone & Internet", "expense");
    const acc = (await used.post("/api/v1/accounts", { providerId: null, name: "Cash", type: "cash", initialBalance: 100_000, initialBalanceDate: "2026-11-01", includeInTotal: true })).body.account.id as string;
    assert.equal((await used.post("/api/v1/transactions", { kind: "expense", accountId: acc, amount: 5_000, date: "2026-11-10", categoryId: phone })).status, 201);
    await runMigration(ctx);
    assert.ok((await names(ctx, "used@example.com", "expense")).includes("Phone & Internet"), "money was recorded under it, so it stays");
  });

  it("running it again changes nothing", async () => {
    const before = await names(ctx, "old@example.com", "expense");
    await runMigration(ctx);
    assert.deepEqual(await names(ctx, "old@example.com", "expense"), before);
  });
});

describe("moving an account with a clash or a hidden category", () => {
  let ctx: TestContext;
  before(async () => {
    ctx = await createContext();
  });
  after(async () => ctx.close());

  it("does not rename onto a name the person already has, and does not bring back a hidden category", async () => {
    const c = await ctx.signUp("clash@example.com", "Clash");
    const uid = sql`(select id from "user" where email = 'clash@example.com')`;
    // The person made their own "Housing" and still has the old "Home"; they also hid the old "Family".
    await ctx.db.execute(sql`delete from categories where user_id = ${uid} and name in ('Housing','Family & Kids')`);
    await ctx.db.execute(sql`insert into categories (user_id, name, kind, sort_order) values (${uid}, 'Housing', 'expense', 50), (${uid}, 'Home', 'expense', 51), (${uid}, 'Family', 'expense', 52)`);
    await ctx.db.execute(sql`update categories set archived_at = now() where user_id = ${uid} and name = 'Family'`);
    await runMigration(ctx);
    const active = await names(ctx, "clash@example.com", "expense");
    assert.equal(active.filter((n) => n === "Housing").length, 1, "still one Housing");
    assert.ok(active.includes("Home"), "Home was not renamed onto the name that was taken");
    const hidden = await names(ctx, "clash@example.com", "expense", true);
    assert.ok(hidden.includes("Family & Kids") || hidden.includes("Family"), "the hidden one stays hidden");
    assert.ok(!active.includes("Family & Kids"), "a hidden category is not brought back");
    void c;
  });
});

describe("the transaction list by category", () => {
  let ctx: TestContext;
  let c: Client;
  let food: string;
  before(async () => {
    ctx = await createContext();
    c = await ctx.signUp("bycat@example.com", "By");
    food = await categoryId(c, "Food & Drinks", "expense");
    const shopping = await categoryId(c, "Shopping", "expense");
    const acc = (await c.post("/api/v1/accounts", { providerId: null, name: "Cash", type: "cash", initialBalance: 100_000, initialBalanceDate: "2026-11-01", includeInTotal: true })).body.account.id as string;
    for (const [amount, categoryId] of [[1_000, food], [2_000, food], [3_000, shopping], [4_000, null]] as const) await c.post("/api/v1/transactions", { kind: "expense", accountId: acc, amount, date: "2026-11-10", categoryId });
  });
  after(async () => ctx.close());

  it("lists only that category", async () => {
    const rows = (await c.get(`/api/v1/transactions?category=${food}`)).body.items as { amount: number }[];
    assert.deepEqual(rows.map((r) => r.amount).sort((a, b) => a - b), [-2000, -1000]);
  });
  it("lists the spending with no category when asked for none", async () => {
    const rows = (await c.get("/api/v1/transactions?category=none&kind=expense")).body.items as { amount: number }[];
    assert.deepEqual(rows.map((r) => r.amount), [-4000]);
  });
  it("refuses something that is not a category id", async () => {
    assert.equal((await c.get("/api/v1/transactions?category=not-an-id")).status, 400);
  });
  it("does not show another person's category", async () => {
    const other = await ctx.signUp("bycat2@example.com", "Other");
    assert.deepEqual((await other.get(`/api/v1/transactions?category=${food}`)).body.items, []);
  });
});

describe("the fee category", () => {
  it("is locked under its new name and under the old one", async () => {
    const ctx = await createContext();
    const c = await ctx.signUp("fee@example.com", "Fee");
    const fee = await categoryId(c, "Financial & Fees", "expense");
    assert.equal((await c.patch(`/api/v1/categories/${fee}`, { name: "Bank things" })).status, 400);
    assert.equal((await c.post(`/api/v1/categories/${fee}/archive`)).status, 400);
    await ctx.db.execute(sql`update categories set name = 'Admin Fee' where id = ${fee}::uuid`);
    assert.equal((await c.patch(`/api/v1/categories/${fee}`, { name: "Bank things" })).status, 400);
    assert.equal((await c.post(`/api/v1/categories/${fee}/archive`)).status, 400);
    await ctx.close();
  });

  it("still gets the fee of a transfer when the account has the old name", async () => {
    const ctx = await createContext();
    const c = await ctx.signUp("fee2@example.com", "Fee");
    await ctx.db.execute(sql`update categories set name = 'Admin Fee' where name = 'Financial & Fees' and user_id = (select id from "user" where email = 'fee2@example.com')`);
    const mk = async (name: string) => (await c.post("/api/v1/accounts", { providerId: null, name, type: "bank", initialBalance: 100_000, initialBalanceDate: "2026-11-01", includeInTotal: true })).body.account.id as string;
    const a = await mk("A");
    const b = await mk("B");
    const res = await c.post("/api/v1/transfers", { fromAccountId: a, toAccountId: b, amount: 10_000, fee: 2_500, date: "2026-11-10" });
    assert.equal(res.status, 201);
    const fee = (res.body.rows as { isTransferFee: boolean; categoryName: string }[]).find((r) => r.isTransferFee);
    assert.equal(fee?.categoryName, "Admin Fee");
    await ctx.close();
  });
});
