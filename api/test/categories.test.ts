import assert from "node:assert/strict";
import { CATEGORY_ICONS, MAX_CATEGORIES } from "@oracle/core";
import { DEFAULT_CATEGORIES } from "@oracle/db/seed/categories";
import { after, before, describe, it } from "node:test";
import { categoryId, createContext, type Client, type TestContext } from "./helpers";

describe("categories: add, hide, and the icon list", () => {
  let ctx: TestContext;
  let c: Client;
  before(async () => {
    ctx = await createContext({ now: "2026-11-19T05:00:00Z" });
    c = await ctx.signUp("cats@example.com");
  });
  after(async () => ctx.close());

  const list = async (client: Client = c) => (await client.get("/api/v1/categories")).body.categories as { id: string; name: string; kind: string; icon: string | null; color: string | null }[];

  it("every default category uses an icon from the list", () => {
    for (const d of DEFAULT_CATEGORIES) assert.ok((CATEGORY_ICONS as readonly string[]).includes(d.icon), `${d.name}: ${d.icon}`);
    assert.equal(new Set(CATEGORY_ICONS).size, CATEGORY_ICONS.length, "no icon listed twice");
    assert.ok(CATEGORY_ICONS.length >= 80, "a good choice of icons");
  });

  it("adds a category of your own with a color, listed after the others of its kind", async () => {
    const res = await c.post("/api/v1/categories", { name: "Coffee", kind: "expense", icon: "coffee" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual([res.body.category.name, res.body.category.kind, res.body.category.icon], ["Coffee", "expense", "coffee"]);
    assert.match(res.body.category.color, /^#[0-9A-F]{6}$/i);
    const expense = (await list()).filter((x) => x.kind === "expense");
    assert.equal(expense.at(-1)?.name, "Coffee");
    const second = await c.post("/api/v1/categories", { name: "Pets", kind: "expense", icon: "paw" });
    assert.equal((await list()).filter((x) => x.kind === "expense").at(-1)?.name, "Pets");
    assert.notEqual(second.body.category.color, res.body.category.color, "colors are handed out in turn");
  });

  it("can be used for a transaction and a budget straight away", async () => {
    const acc = await c.post("/api/v1/accounts", { providerId: null, name: "Cash", type: "cash", initialBalance: 100_000, initialBalanceDate: "2026-11-01", includeInTotal: true });
    const cat = await categoryId(c, "Coffee", "expense");
    const tx = await c.post("/api/v1/transactions", { kind: "expense", accountId: acc.body.account.id, amount: 20_000, date: "2026-11-18", categoryId: cat });
    assert.equal(tx.status, 201);
    assert.equal(tx.body.transaction.categoryName, "Coffee");
    assert.equal(tx.body.transaction.categoryIcon, "coffee");
    assert.equal((await c.call("PUT", "/api/v1/budgets/2026-11", { items: [{ categoryId: cat, amount: 200_000 }] })).status, 200);
  });

  it("allows the same name for an expense and an income category, but not twice in one kind", async () => {
    assert.equal((await c.post("/api/v1/categories", { name: "Rent", kind: "expense", icon: "home-variant" })).status, 201);
    assert.equal((await c.post("/api/v1/categories", { name: "Rent", kind: "income", icon: "home-variant" })).status, 201);
    const dup = await c.post("/api/v1/categories", { name: "Rent", kind: "expense", icon: "bank" });
    assert.deepEqual([dup.status, dup.body.error.code], [400, "duplicate_category"]);
  });

  it("rejects bad input", async () => {
    const bad: [string, unknown][] = [
      ["empty name", { name: "  ", kind: "expense", icon: "coffee" }],
      ["long name", { name: "x".repeat(41), kind: "expense", icon: "coffee" }],
      ["bad kind", { name: "A", kind: "transfer", icon: "coffee" }],
      ["unknown icon", { name: "A", kind: "expense", icon: "skull" }],
      ["old icon name", { name: "A", kind: "expense", icon: "utensils" }],
      ["no icon", { name: "A", kind: "expense" }],
    ];
    for (const [label, body] of bad) assert.equal((await c.post("/api/v1/categories", body)).status, 400, label);
  });

  it("stops at the limit", async () => {
    const big = await ctx.signUp("many-cats@example.com");
    const have = (await list(big)).length;
    for (let i = have; i < MAX_CATEGORIES; i += 1) assert.equal((await big.post("/api/v1/categories", { name: `Cat ${i}`, kind: "expense", icon: "tag" })).status, 201);
    const over = await big.post("/api/v1/categories", { name: "One too many", kind: "expense", icon: "tag" });
    assert.deepEqual([over.status, over.body.error.code], [400, "too_many_categories"]);
  });

  it("hides a category but keeps it on the transactions that used it", async () => {
    const cat = await categoryId(c, "Coffee", "expense");
    const before = (await c.get("/api/v1/transactions?q=Coffee")).body.items.length;
    const res = await c.post(`/api/v1/categories/${cat}/archive`);
    assert.equal(res.status, 204);
    assert.ok(!(await list()).some((x) => x.id === cat), "gone from the pickers");
    const tx = (await c.get("/api/v1/transactions?q=Coffee")).body.items;
    assert.equal(tx.length, before);
    assert.equal(tx[0].categoryName, "Coffee", "history still reads the same");
    assert.deepEqual((await c.get("/api/v1/budgets?month=2026-11")).body.items, [], "its budget went with it");
    assert.equal((await c.post(`/api/v1/categories/${cat}/archive`)).status, 404, "already hidden");
    assert.equal((await c.post("/api/v1/categories", { name: "Coffee", kind: "expense", icon: "coffee" })).status, 201, "the name is free again");
  });

  it("cannot hide the fee category, and nobody else's category", async () => {
    const fee = await categoryId(c, "Financial & Fees", "expense");
    const r = await c.post(`/api/v1/categories/${fee}/archive`);
    assert.deepEqual([r.status, r.body.error.code], [400, "category_locked"]);
    const other = await ctx.signUp("someone-cats@example.com");
    assert.equal((await other.post(`/api/v1/categories/${fee}/archive`)).status, 404);
    assert.equal((await other.post("/api/v1/categories/not-a-uuid/archive")).status, 404);
    assert.ok((await list()).some((x) => x.id === fee), "still there");
  });

  it("needs a login", async () => {
    assert.equal((await ctx.anonymous.post("/api/v1/categories", { name: "A", kind: "expense", icon: "tag" })).status, 401);
    assert.equal((await ctx.anonymous.post("/api/v1/categories/x/archive")).status, 401);
  });
});
