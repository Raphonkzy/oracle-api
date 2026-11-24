import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { after, before, describe, it } from "node:test";
import { APP_GUIDE, GUIDE_LABELS_USED, lookupGuide } from "@oracle/core";
import { runTool, type ToolContext } from "../src/ai/tools";
import { chatSystemPrompt } from "../src/ai/prompts";
import { balanceOf, categoryId, createContext, type Client, type TestContext } from "./helpers";

describe("the assistant knows the app and speaks the app's category names", () => {
  let ctx: TestContext;
  let me: Client;
  let userId: string;
  let bca: string;
  const context = (over: Partial<ToolContext> = {}): ToolContext => ({ db: ctx.db, userId, today: "2026-11-19", language: "id", drafts: [], changes: [], known: new Set<number>(), userWroteDigits: false, ...over });
  const run = async (c: ToolContext, tool: string, args: unknown) => (await runTool(c, tool, JSON.stringify(args))) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

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

  describe("account endpoints", () => {
    it("search_transactions marks a transfer leg and does not offer it for editing", async () => {
      const gopay = (await me.post("/api/v1/accounts", { providerId: null, name: "GoPay", type: "ewallet", initialBalance: 0, initialBalanceDate: "2026-11-01", includeInTotal: true })).body.account.id as string;
      const made = await me.post("/api/v1/transfers", { fromAccountId: bca, toAccountId: gopay, amount: 30_000, fee: 0, date: "2026-11-18" });
      assert.equal(made.status, 201, JSON.stringify(made.body));
      const found = await run(context(), "search_transactions", { from: "2026-11-18", to: "2026-11-18" });
      const legs = (found.transactions as { editable: boolean; transferLeg: boolean; amount: number }[]).filter((t) => t.transferLeg);
      assert.ok(legs.length >= 2, "both legs are listed");
      assert.ok(legs.every((t) => t.editable === false));
      const plain = (found.transactions as { editable: boolean; transferLeg: boolean }[]).filter((t) => !t.transferLeg);
      assert.ok(plain.every((t) => t.editable === true));
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
