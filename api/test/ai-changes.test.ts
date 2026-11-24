import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { after, before, describe, it } from "node:test";
import { runTool, type ToolContext } from "../src/ai/tools";
import { categoryId, createContext, type Client, type TestContext } from "./helpers";

type Result = { saved: boolean; proposed: Record<string, unknown>[]; errors: { index: number; message: string }[] };

describe("the assistant proposes changes, and changes nothing itself", () => {
  let ctx: TestContext;
  let me: Client;
  let other: Client;
  let userId: string;
  let lunchId: string;
  let transferRowId: string;
  let bca: string;
  let gopay: string;
  const rows = async () => Number(((await ctx.db.execute(sql`select count(*) as n from transactions`)) as unknown as { n: string }[])[0].n);
  const snapshot = async () => JSON.stringify(await ctx.db.execute(sql`select id, amount, date::text, category_id, description from transactions order by id`));
  const everything = async () => {
    const tables = ["money_accounts", "transactions", "transfers", "budgets", "categories", "user_settings"];
    const out: unknown[] = [];
    for (const t of tables) out.push(await ctx.db.execute(sql.raw(`select * from ${t} order by 1`)));
    return JSON.stringify(out);
  };
  const budgets = async () => Number(((await ctx.db.execute(sql`select count(*) as n from budgets`)) as unknown as { n: string }[])[0].n);
  const cats = async () => Number(((await ctx.db.execute(sql`select count(*) as n from categories`)) as unknown as { n: string }[])[0].n);
  const context = (over: Partial<ToolContext> = {}): ToolContext => ({ db: ctx.db, userId, today: "2026-11-19", drafts: [], changes: [], known: new Set<number>(), userWroteDigits: false, ...over });
  const propose = async (c: ToolContext, changes: unknown[]) => (await runTool(c, "propose_changes", JSON.stringify({ changes }))) as Result;

  before(async () => {
    ctx = await createContext({ now: "2026-11-19T05:00:00Z" });
    me = await ctx.signUp("changes@example.com", "Me");
    other = await ctx.signUp("changes2@example.com", "Other");
    userId = ((await ctx.db.execute(sql`select id from "user" where email = 'changes@example.com'`)) as unknown as { id: string }[])[0].id;
    const mk = async (c: Client, name: string) => (await c.post("/api/v1/accounts", { providerId: null, name, type: "bank", initialBalance: 1_000_000, initialBalanceDate: "2026-11-01", includeInTotal: true })).body.account.id as string;
    bca = await mk(me, "BCA");
    gopay = await mk(me, "GoPay");
    await mk(me, "Dana");
    const food = await categoryId(me, "Food & Drinks", "expense");
    lunchId = (await me.post("/api/v1/transactions", { kind: "expense", accountId: bca, amount: 40_000, date: "2026-11-16", categoryId: food, description: "Lunch" })).body.transaction.id as string;
    transferRowId = (await me.post("/api/v1/transfers", { fromAccountId: bca, toAccountId: gopay, amount: 10_000, fee: 2_500, date: "2026-11-17" })).body.rows[0].id as string;
  });
  after(async () => ctx.close());

  it("an edit becomes a card with before and after, and the database is untouched", async () => {
    const c = context({ known: new Set([45_000]), userWroteDigits: true });
    const before = await snapshot();
    const res = await propose(c, [{ action: "edit_transaction", transaction_id: lunchId, amount: 45_000, category: "Transportation", account: "GoPay", description: "Lunch with a friend" }]);
    assert.equal(res.saved, false);
    assert.deepEqual(res.errors, []);
    assert.equal(c.changes.length, 1);
    const ch = c.changes[0];
    assert.equal(ch.type, "edit_transaction");
    if (ch.type !== "edit_transaction") return;
    assert.deepEqual(ch.fields.map((f) => [f.field, f.from, f.to]), [["amount", 40_000, 45_000], ["description", "Lunch", "Lunch with a friend"], ["category", "Food & Drinks", "Transportation"], ["account", "BCA", "GoPay"]]);
    assert.equal(ch.patch.amount, 45_000);
    assert.equal(ch.transactionId, lunchId);
    assert.equal(await snapshot(), before, "nothing was changed");
  });

  it("a delete is a card, and nothing is deleted", async () => {
    const c = context();
    const n = await rows();
    const res = await propose(c, [{ action: "delete_transaction", transaction_id: lunchId }]);
    assert.deepEqual(res.errors, []);
    assert.equal(c.changes[0].type, "delete_transaction");
    assert.equal(await rows(), n);
  });

  it("another person's transaction is the same as one that does not exist", async () => {
    const theirs = ((await ctx.db.execute(sql`select id from transactions limit 1`)) as unknown as { id: string }[])[0].id;
    const asOther = ((await ctx.db.execute(sql`select id from "user" where email = 'changes2@example.com'`)) as unknown as { id: string }[])[0].id;
    const c = context({ userId: asOther });
    const res = await propose(c, [{ action: "delete_transaction", transaction_id: theirs }, { action: "edit_transaction", transaction_id: crypto.randomUUID(), amount: 1 }, { action: "delete_transaction", transaction_id: "not-an-id" }]);
    assert.equal(c.changes.length, 0);
    assert.equal(res.errors.length, 3);
    void other;
  });

  it("a transfer leg gives transfer cards, and edit_transaction on it is still refused", async () => {
    const c = context();
    const res = await propose(c, [{ action: "delete_transaction", transaction_id: transferRowId }, { action: "edit_transaction", transaction_id: transferRowId, amount: 5 }]);
    assert.equal(c.changes.length, 0);
    assert.match(res.errors[0].message, /edit_transfer or delete_transfer/);
    assert.match(res.errors[1].message, /edit_transfer or delete_transfer/);
    const ok = context({ userWroteDigits: true, known: new Set([12_000]) });
    const res2 = await propose(ok, [{ action: "edit_transfer", transaction_id: transferRowId, amount: 12_000 }]);
    assert.deepEqual(res2.errors, []);
    const ch = ok.changes[0];
    assert.equal(ch.type, "edit_transfer");
    if (ch.type === "edit_transfer") assert.deepEqual([ch.amount, ch.fee, ch.fromAccountName, ch.toAccountName, ch.patch.amount, ch.fields.length], [10_000, 2_500, "BCA", "GoPay", 12_000, 1]);
    const del = context();
    assert.deepEqual((await propose(del, [{ action: "delete_transfer", transaction_id: transferRowId }])).errors, []);
    assert.equal(del.changes[0].type, "delete_transfer");
    // A plain transaction is not a transfer.
    const plain = await propose(context(), [{ action: "delete_transfer", transaction_id: lunchId }]);
    assert.equal(plain.errors.length, 1);
  });
  it("a new amount must be one the person wrote or one from their data", async () => {
    const c = context({ userWroteDigits: true, known: new Set([40_000]) });
    const res = await propose(c, [{ action: "edit_transaction", transaction_id: lunchId, amount: 99_000 }]);
    assert.equal(c.changes.length, 0);
    assert.match(res.errors[0].message, /not a number the person wrote/);
    const ok = context({ userWroteDigits: true, known: new Set([99_000]) });
    assert.deepEqual((await propose(ok, [{ action: "edit_transaction", transaction_id: lunchId, amount: 99_000 }])).errors, []);
  });

  it("refuses an edit that changes nothing, a wrong category kind, an unknown account, a bad date and a second proposal for one row", async () => {
    const c = context();
    const res = await propose(c, [
      { action: "edit_transaction", transaction_id: lunchId, amount: 40_000 },
      { action: "edit_transaction", transaction_id: lunchId, category: "Salary" },
      { action: "edit_transaction", transaction_id: lunchId, account: "Nope Bank" },
      { action: "edit_transaction", transaction_id: lunchId, date: "2001-01-01" },
      { action: "edit_transaction", transaction_id: lunchId, category: "Shopping" },
      { action: "edit_transaction", transaction_id: lunchId, category: "Health" },
    ]);
    assert.equal(c.changes.length, 1, "only the valid edit became a card");
    assert.deepEqual(res.errors.map((e) => e.index), [0, 1, 2, 3, 5]);
    assert.match(res.errors[4 - 0].message, /already has a proposal/);
  });

  it("a budget is a card with what it is now and what it would become, and nothing is saved", async () => {
    const c = context({ userWroteDigits: true, known: new Set([300_000]) });
    const n = await budgets();
    const res = await propose(c, [{ action: "set_budget", category: "Food & Drinks", amount: 300_000 }]);
    assert.deepEqual(res.errors, []);
    const ch = c.changes[0];
    assert.equal(ch.type, "set_budget");
    if (ch.type === "set_budget") assert.deepEqual([ch.month, ch.from, ch.to, ch.categoryName], ["2026-11", null, 300_000, "Food & Drinks"]);
    assert.equal(await budgets(), n);
    // Removing a budget that does not exist, and an income category, are refused.
    const bad = context();
    const res2 = await propose(bad, [{ action: "set_budget", category: "Food & Drinks", amount: 0 }, { action: "set_budget", category: "Salary", amount: 5 }]);
    assert.equal(bad.changes.length, 0);
    assert.equal(res2.errors.length, 2);
  });

  it("a new category is a card, a duplicate is refused, and an unknown icon becomes the default", async () => {
    const c = context();
    const n = await cats();
    const res = await propose(c, [{ action: "create_category", name: "Pets", kind: "expense", icon: "paw" }, { action: "create_category", name: "food & drinks", kind: "expense" }, { action: "create_category", name: "Odd", kind: "expense", icon: "../../etc" }]);
    assert.equal(c.changes.length, 2);
    assert.equal(res.errors.length, 1);
    const [pets, odd] = c.changes;
    assert.deepEqual([pets.type === "create_category" && pets.icon, odd.type === "create_category" && odd.icon], ["paw", "tag"]);
    assert.equal(await cats(), n);
  });

  it("is capped at 20 proposals for one answer, drafts included", async () => {
    const c = context();
    const many = Array.from({ length: 25 }, (_, i) => ({ action: "create_category", name: `Cat ${i}`, kind: "expense" }));
    const res = await propose(c, many);
    assert.equal(c.changes.length, 20);
    assert.equal(res.errors.length, 5);
  });

  it("search gives the id and says whether a row can be edited", async () => {
    const res = (await runTool(context(), "search_transactions", JSON.stringify({ limit: 10 }))) as { transactions: { id: string; editable: boolean; transferLeg: boolean; type: string }[] };
    const lunch = res.transactions.find((t) => t.id === lunchId);
    assert.equal(lunch?.editable, true);
    assert.equal(res.transactions.find((t) => t.id === lunchId)?.transferLeg, false);
    assert.ok(res.transactions.filter((t) => t.transferLeg).every((t) => !t.editable), "transfer rows are marked and not editable");
    assert.ok(res.transactions.filter((t) => !t.editable).length >= 2, "the transfer rows are not editable");
  });
  it("each of the eleven change types returns one card and saves nothing", async () => {
    const cases: [string, Record<string, unknown>][] = [
      ["edit_transaction", { action: "edit_transaction", transaction_id: lunchId, description: "Late lunch" }],
      ["delete_transaction", { action: "delete_transaction", transaction_id: lunchId }],
      ["edit_transfer", { action: "edit_transfer", transaction_id: transferRowId, to_account: "Dana", fee: 0 }],
      ["delete_transfer", { action: "delete_transfer", transaction_id: transferRowId }],
      ["set_budget", { action: "set_budget", category: "Food & Drinks", amount: 250_000 }],
      ["create_category", { action: "create_category", name: "Hobbies", kind: "expense" }],
      ["rename_category", { action: "rename_category", category: "Shopping", name: "Stuff", kind: "expense" }],
      ["hide_category", { action: "hide_category", category: "Health", kind: "expense" }],
      ["set_cycle_start", { action: "set_cycle_start", day: 25 }],
      ["set_theme", { action: "set_theme", theme: "midnight" }],
      ["set_language", { action: "set_language", language: "id" }],
    ];
    for (const [type, change] of cases) {
      const c = context();
      const before = await everything();
      const res = await propose(c, [change]);
      assert.deepEqual(res.errors, [], type);
      assert.equal(res.saved, false);
      assert.equal(c.changes.length, 1, type);
      assert.equal(c.changes[0].type, type);
      assert.equal(await everything(), before, `${type} wrote nothing`);
    }
    const t = context();
    await propose(t, [{ action: "edit_transfer", transaction_id: transferRowId, to_account: "Dana", fee: 0 }]);
    const ch = t.changes[0];
    if (ch.type === "edit_transfer") assert.deepEqual(ch.fields.map((f) => [f.field, f.to]), [["fee", 0], ["to_account", "Dana"]]);
    const cy = context();
    await propose(cy, [{ action: "set_cycle_start", day: 25 }]);
    assert.deepEqual(cy.changes[0].type === "set_cycle_start" && [cy.changes[0].from, cy.changes[0].to], [1, 25]);
  });
  it("transfer edits keep the two accounts different and need a real change", async () => {
    const c = context();
    const res = await propose(c, [
      { action: "edit_transfer", transaction_id: transferRowId, to_account: "BCA" },
      { action: "edit_transfer", transaction_id: transferRowId, amount: 10_000, fee: 2_500 },
      { action: "edit_transfer", transaction_id: transferRowId, account: "Nope Bank" },
    ]);
    assert.equal(c.changes.length, 0);
    assert.equal(res.errors.length, 3);
    assert.match(res.errors[0].message, /two different accounts/);
  });
  it("category rename and hide refuse the fee category and a clash, and a hide asks which one on a shared name", async () => {
    const c = context();
    const res = await propose(c, [
      { action: "rename_category", category: "Financial & Fees", name: "Fees", kind: "expense" },
      { action: "hide_category", category: "Financial & Fees", kind: "expense" },
      { action: "rename_category", category: "Shopping", name: "health", kind: "expense" },
      { action: "rename_category", category: "Shopping", name: "x".repeat(41), kind: "expense" },
      { action: "hide_category", category: "Nothing like it" },
    ]);
    assert.equal(c.changes.length, 0);
    assert.equal(res.errors.length, 5);
    assert.match(res.errors[0].message, /fees category/);
    assert.match(res.errors[2].message, /already a expense category/);
    await ctx.db.execute(sql`insert into categories (user_id, name, kind, icon) values (${userId}, 'Gift', 'expense', 'tag'), (${userId}, 'Gift', 'income', 'tag')`);
    const both = context();
    const ask = await propose(both, [{ action: "hide_category", category: "Gift" }]);
    assert.equal(both.changes.length, 0);
    assert.match(ask.errors[0].message, /More than one category/);
    const picked = context();
    assert.deepEqual((await propose(picked, [{ action: "hide_category", category: "Gift", kind: "income" }])).errors, []);
    await ctx.db.execute(sql`delete from categories where user_id = ${userId} and name = 'Gift'`);
  });
  it("account actions and unknown actions are rejected by the schema and make no card", async () => {
    const c = context();
    const res = await propose(c, [
      { action: "create_account", name: "New", account_type: "bank" },
      { action: "rename_account", account: "BCA", name: "Bank" },
      { action: "update_balance", account: "BCA", amount: 5 },
      { action: "unhide_category", category: "Health" },
      { action: "rename_profile", name: "Me" },
    ]);
    assert.equal(c.changes.length, 0);
    assert.equal(res.errors.length, 5);
    // The tool description no longer offers them.
    const spec = JSON.stringify((await import("../src/ai/tools")).TOOL_SPECS.find((t) => t.function.name === "propose_changes"));
    assert.doesNotMatch(spec, /create_account|rename_account|update_balance|account_type/);
    assert.doesNotMatch(spec, /Transfers cannot be changed here/);
  });
  it("drafts and changes count toward the same cap of 20", async () => {
    const draft = { id: "d", kind: "expense", amount: 1, date: "2026-11-19", description: null, accountId: bca, accountName: "BCA", categoryId: null, categoryName: null, toAccountId: null, toAccountName: null, fee: 0 } as const;
    const c = context({ drafts: Array.from({ length: 15 }, () => ({ ...draft })) });
    const res = await propose(c, Array.from({ length: 8 }, (_, i) => ({ action: "create_category", name: `Capped ${i}`, kind: "expense" })));
    assert.equal(c.changes.length, 5, "the cards already made are kept");
    assert.equal(res.errors.length, 3);
    const back = (await runTool(c, "propose_transactions", JSON.stringify({ items: [{ kind: "expense", amount: 5, account: "BCA" }] }))) as { errors: { message: string }[] };
    assert.equal(c.drafts.length, 15);
    assert.match(back.errors[0].message, /At most 20/);
  });
  it("a theme, language or day outside the allowed set is refused, and so is the current month start", async () => {
    const c = context();
    const res = await propose(c, [
      { action: "set_theme", theme: "neon" },
      { action: "set_theme" },
      { action: "set_language", language: "xx" },
      { action: "set_cycle_start", day: 0 },
      { action: "set_cycle_start", day: 29 },
      { action: "set_cycle_start", day: 1.5 },
      { action: "set_cycle_start", day: 1 },
    ]);
    assert.equal(c.changes.length, 0);
    assert.equal(res.errors.length, 7);
    assert.match(res.errors[6].message, /already starts/);
  });
});
