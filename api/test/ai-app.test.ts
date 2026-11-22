import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { after, before, describe, it } from "node:test";
import { APP_GUIDE, GUIDE_LABELS_USED, lookupGuide } from "@oracle/core";
import { runTool, type ToolContext } from "../src/ai/tools";
import { chatSystemPrompt } from "../src/ai/prompts";
import { balanceOf, categoryId, createContext, type Client, type TestContext } from "./helpers";

type Proposal = { saved: boolean; proposed: Record<string, unknown>[]; errors: { index: number; message: string }[] };

describe("the assistant knows the app, speaks the app's category names and manages accounts", () => {
  let ctx: TestContext;
  let me: Client;
  let userId: string;
  let bca: string;
  const context = (over: Partial<ToolContext> = {}): ToolContext => ({ db: ctx.db, userId, today: "2026-11-19", language: "id", drafts: [], changes: [], known: new Set<number>(), userWroteDigits: false, ...over });
  const run = async (c: ToolContext, tool: string, args: unknown) => (await runTool(c, tool, JSON.stringify(args))) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const accountsCount = async () => Number(((await ctx.db.execute(sql`select count(*) as n from money_accounts`)) as unknown as { n: string }[])[0].n);

  before(async () => {
    ctx = await createContext({ now: "2026-11-19T05:00:00Z" });
    me = await ctx.signUp("app@example.com", "Me");
    userId = ((await ctx.db.execute(sql`select id from "user" where email = 'app@example.com'`)) as unknown as { id: string }[])[0].id;
    bca = (await me.post("/api/v1/accounts", { providerId: null, name: "BCA", type: "bank", initialBalance: 1_000_000, initialBalanceDate: "2026-11-01", includeInTotal: true })).body.account.id as string;
    await me.post("/api/v1/accounts", { providerId: null, name: "SPayLater", type: "paylater", initialBalance: -200_000, initialBalanceDate: "2026-11-01", includeInTotal: true });
    const food = await categoryId(me, "Food & Drinks", "expense");
    assert.equal((await me.post("/api/v1/transactions", { kind: "expense", accountId: bca, amount: 50_000, date: "2026-11-10", categoryId: food, description: "Lunch" })).status, 201);
  });
  after(async () => ctx.close());

  describe("category names follow the app language", () => {
    it("tool results use the names the person sees", async () => {
      const spending = await run(context(), "get_spending", { period: "month" });
      assert.equal(spending.categories[0].name, "Makanan & Minuman");
      const english = await run(context({ language: "en" }), "get_spending", { period: "month" });
      assert.equal(english.categories[0].name, "Food & Drinks");
      const search = await run(context(), "search_transactions", {});
      assert.equal(search.transactions[0].category, "Makanan & Minuman");
      const grouped = await run(context(), "aggregate_transactions", { from: "2026-11-01", to: "2026-11-30", group_by: "category", kind: "expense" });
      assert.equal(grouped.groups[0].label, "Makanan & Minuman");
    });

    it("either the app-language name or the stored name finds the category", async () => {
      for (const name of ["Makanan & Minuman", "Food & Drinks", "makanan"]) {
        const grouped = await run(context(), "aggregate_transactions", { from: "2026-11-01", to: "2026-11-30", group_by: "category", kind: "expense", category: name });
        assert.equal(grouped.total, 50_000, name);
      }
      const c = context();
      const res = (await run(c, "propose_transactions", { items: [{ kind: "expense", amount: 25_000, account: "BCA", category: "Makanan & Minuman", description: "Kopi" }] })) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      assert.deepEqual(res.errors, []);
      assert.equal(c.drafts[0].categoryName, "Makanan & Minuman");
      assert.ok(c.drafts[0].categoryId, "it is the real category");
    });

    it("the instructions list the names the way the app shows them", () => {
      const prompt = chatSystemPrompt({ language: "id", today: "2026-11-19", weekday: "Thursday", canary: "ORC-00000000", accounts: ["BCA (bank)"], expenseCategories: ["Makanan & Minuman"], incomeCategories: ["Gaji"] });
      assert.match(prompt, /Makanan & Minuman/);
      assert.match(prompt, /Indonesian/);
      assert.match(prompt, /rekening = bank account/);
    });
  });

  describe("the app guide", () => {
    it("every label it names is a real, translated sentence of the app", () => {
      assert.ok(GUIDE_LABELS_USED.length > 20);
      const g = lookupGuide("how do I change the month start", "id");
      const text = JSON.stringify(g.entries);
      assert.match(text, /Preferensi/, "the real Indonesian name of Preferences");
      assert.match(text, /Bulan dimulai|Awal bulan|Bulan mulai/i);
      assert.doesNotMatch(text, /\[\[/);
    });

    it("finds the right topic in English and in other languages", () => {
      assert.equal(lookupGuide("how do I add an expense", "en").entries[0].id, "add-transaction");
      assert.equal(lookupGuide("cara mengubah tema tampilan", "id").entries[0].id, "appearance");
      assert.equal(lookupGuide("set a budget limit", "en").entries[0].id, "budget");
      assert.equal(lookupGuide("update balance to match gopay", "en").entries[0].id, "update-balance");
    });

    it("without a question it lists every topic, and an unknown question finds nothing to invent from", async () => {
      assert.equal(lookupGuide(undefined, "en").topics.length, APP_GUIDE.length);
      const none = lookupGuide("quantum entanglement", "en");
      assert.deepEqual(none.entries, []);
      const tool = await run(context(), "get_app_guide", { question: "blockchain staking" });
      assert.deepEqual(tool.entries, []);
      assert.match(tool.note, /Do not invent/);
    });

    it("the tool answers in the app language's own screen names", async () => {
      const tool = await run(context({ language: "de" }), "get_app_guide", { question: "language" });
      assert.match(JSON.stringify(tool.entries), /Einstellungen/);
    });
  });

  describe("accounts by chat", () => {
    it("a new account is a card, and nothing is created", async () => {
      const c = context({ userWroteDigits: true, known: new Set([500_000]) });
      const n = await accountsCount();
      const res = (await run(c, "propose_changes", { changes: [{ action: "create_account", name: "Jago", account_type: "bank", amount: 500_000 }] })) as unknown as Proposal;
      assert.deepEqual(res.errors, []);
      assert.equal(res.saved, false);
      assert.equal(c.changes[0].type, "create_account");
      assert.equal(await accountsCount(), n);
      if (c.changes[0].type === "create_account") assert.deepEqual([c.changes[0].initialBalance, c.changes[0].accountType], [500_000, "bank"]);
    });

    it("a paylater account is stored as money owed", async () => {
      const c = context({ userWroteDigits: true, known: new Set([300_000]) });
      await run(c, "propose_changes", { changes: [{ action: "create_account", name: "Kredivo", account_type: "paylater", amount: 300_000 }] });
      const ch = c.changes[0];
      assert.equal(ch.type === "create_account" && ch.initialBalance, -300_000);
    });

    it("refuses a name that already exists and an amount the person did not write", async () => {
      const dup = context();
      const r1 = (await run(dup, "propose_changes", { changes: [{ action: "create_account", name: "bca", account_type: "bank" }] })) as unknown as Proposal;
      assert.match(r1.errors[0].message, /already an account/);
      const made = context({ userWroteDigits: true, known: new Set([1]) });
      const r2 = (await run(made, "propose_changes", { changes: [{ action: "create_account", name: "Jago", account_type: "bank", amount: 999_000 }] })) as unknown as Proposal;
      assert.match(r2.errors[0].message, /not a number the person wrote/);
      assert.equal(made.changes.length, 0);
    });

    it("renaming and updating a balance are cards with before and after", async () => {
      const c = context({ userWroteDigits: true, known: new Set([900_000]) });
      const res = (await run(c, "propose_changes", { changes: [{ action: "rename_account", account: "BCA", name: "BCA Utama" }, { action: "update_balance", account: "SPayLater", amount: 900_000 }] })) as unknown as Proposal;
      assert.deepEqual(res.errors, []);
      const [rename, balance] = c.changes;
      assert.equal(rename.type === "rename_account" && `${rename.from}>${rename.to}`, "BCA>BCA Utama");
      if (balance.type !== "update_balance") throw new Error("expected a balance update");
      assert.deepEqual([balance.from, balance.to], [-200_000, -900_000], "the bill is owed, so it is stored negative");
      assert.equal(await balanceOf(me, bca), 950_000, "nothing changed");
    });

    it("a balance update to the balance it already has changes nothing", async () => {
      const c = context({ userWroteDigits: true, known: new Set([950_000]) });
      const res = (await run(c, "propose_changes", { changes: [{ action: "update_balance", account: "BCA", amount: 950_000 }] })) as unknown as Proposal;
      assert.match(res.errors[0].message, /already has that balance/);
    });

    it("the card, once confirmed in the app, goes through the ordinary endpoints with their checks", async () => {
      // What the app does with a confirmed card.
      const made = await me.post("/api/v1/accounts", { providerId: null, name: "Jago", type: "bank", initialBalance: 500_000, initialBalanceDate: "2026-11-19", includeInTotal: true });
      assert.equal(made.status, 201);
      assert.equal((await me.patch(`/api/v1/accounts/${made.body.account.id}`, { name: "Jago Utama" })).body.account.name, "Jago Utama");
      const adjust = await me.post(`/api/v1/accounts/${made.body.account.id}/balance-checks`, { actualBalance: 450_000, date: "2026-11-19" });
      assert.equal(adjust.body.difference, -50_000);
      assert.equal(await balanceOf(me, made.body.account.id), 450_000);
    });
  });

  it("the view the person is looking at is told to the model", () => {
    const prompt = chatSystemPrompt({ language: "en", today: "2026-11-19", weekday: "Thursday", canary: "ORC-00000000", accounts: [], expenseCategories: [], incomeCategories: [], view: { screen: "stats", period: "month", from: "2026-10-01", to: "2026-10-31" } });
    assert.match(prompt, /screen: stats/);
    assert.match(prompt, /dates on screen: 2026-10-01 to 2026-10-31/);
  });

  it("read tools can look at an earlier period, like the screens", async () => {
    const old = await me.post("/api/v1/transactions", { kind: "expense", accountId: bca, amount: 7_000, date: "2026-10-12", categoryId: null, description: "Old" });
    assert.equal(old.status, 201, JSON.stringify(old.body));
    const october = await run(context(), "get_spending", { period: "month", date: "2026-10-20" });
    assert.deepEqual(october.range, { from: "2026-10-01", to: "2026-10-31" });
    assert.equal(october.totalSpending, 7_000);
    const now = await run(context(), "get_spending", { period: "month" });
    assert.deepEqual(now.range, { from: "2026-11-01", to: "2026-11-30" });
  });
});
