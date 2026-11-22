import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { sql } from "drizzle-orm";
import { balanceOf, categoryId, createContext, seedAccounts, type Client, type TestContext } from "./helpers";

type Ids = Awaited<ReturnType<typeof seedAccounts>>;
type Row = { id: string; kind: string; amount: number; date: string; description: string | null; categoryName: string | null; accountName: string; counterpartName: string | null; isTransferFee: boolean; runningBalance: number | null; transferId: string | null };

const expense = (accountId: string, amount: number, date: string, extra: Record<string, unknown> = {}) => ({ kind: "expense", accountId, amount, date, categoryId: null, ...extra });
const income = (accountId: string, amount: number, date: string, extra: Record<string, unknown> = {}) => ({ kind: "income", accountId, amount, date, categoryId: null, ...extra });

async function all(c: Client, query = ""): Promise<Row[]> {
  const res = await c.get(`/api/v1/transactions?limit=200${query ? "&" + query : ""}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.items;
}

describe("a week of real activity", () => {
  let ctx: TestContext;
  let c: Client;
  let ids: Ids;
  let transport: string, food: string, salary: string;

  before(async () => {
    ctx = await createContext();
    c = await ctx.signUp("flow@example.com");
    ids = await seedAccounts(c);
    transport = await categoryId(c, "Transportation", "expense");
    food = await categoryId(c, "Food & Drinks", "expense");
    salary = await categoryId(c, "Salary", "income");
  });
  after(async () => ctx.close());

  it("expenses and income change the account balance and keep their sign", async () => {
    const bensin = await c.post("/api/v1/transactions", expense(ids.myBCA, 50_000, "2026-11-17", { categoryId: transport, description: "Bensin" }));
    assert.equal(bensin.status, 201);
    assert.deepEqual([bensin.body.transaction.amount, bensin.body.transaction.kind, bensin.body.transaction.categoryName, bensin.body.transaction.accountName], [-50_000, "expense", "Transportation", "myBCA"]);
    const parkir = await c.post("/api/v1/transactions", expense(ids.Celengan, 5_000, "2026-11-17", { categoryId: transport, description: "Parkir" }));
    assert.equal(parkir.status, 201);
    assert.equal(await balanceOf(c, ids.myBCA), 4_200_000);
    assert.equal(await balanceOf(c, ids.Celengan), 95_000);
  });

  it("a transfer with a fee moves money, books the fee as an expense, and leaves 3 linked rows", async () => {
    const res = await c.post("/api/v1/transfers", { fromAccountId: ids.myBCA, toAccountId: ids.GoPay, amount: 100_000, fee: 2_500, date: "2026-11-18", note: "Top up" });
    assert.equal(res.status, 201);
    const rows = res.body.rows as Row[];
    assert.deepEqual(rows.map((r) => r.kind), ["transfer_out", "transfer_in", "expense"]);
    assert.deepEqual(rows.map((r) => r.amount), [-100_000, 100_000, -2_500]);
    assert.equal(new Set(rows.map((r) => r.transferId)).size, 1);
    assert.ok(rows[0].transferId);
    assert.deepEqual([rows[0].counterpartName, rows[1].counterpartName], ["GoPay", "myBCA"]);
    assert.deepEqual([rows[2].isTransferFee, rows[2].categoryName, rows[2].description], [true, "Financial & Fees", "Transfer fee"]);
    assert.equal(await balanceOf(c, ids.myBCA), 4_097_500);
    assert.equal(await balanceOf(c, ids.GoPay), 335_500);
  });

  it("a transfer without a fee makes two rows", async () => {
    const res = await c.post("/api/v1/transfers", { fromAccountId: ids["BYOND by BSI"], toAccountId: ids.DANA, amount: 10_000, date: "2026-11-18" });
    assert.equal(res.status, 201);
    assert.deepEqual((res.body.rows as Row[]).map((r) => r.kind), ["transfer_out", "transfer_in"]);
    // Undo so the numbers in the next tests stay simple.
    assert.equal((await c.del(`/api/v1/transactions/${res.body.rows[0].id}`)).status, 204);
    assert.equal(await balanceOf(c, ids.DANA), 0);
  });

  it("salary and coffee on the last day", async () => {
    assert.equal((await c.post("/api/v1/transactions", income(ids.myBCA, 5_000_000, "2026-11-19", { categoryId: salary, description: "Gaji November" }))).status, 201);
    assert.equal((await c.post("/api/v1/transactions", expense(ids.myBCA, 30_000, "2026-11-19", { categoryId: food, description: "Kopi" }))).status, 201);
    assert.equal(await balanceOf(c, ids.myBCA), 9_067_500);
  });

  it("total, assets, debts and month flow match a hand count; transfers are not income or expense", async () => {
    const s = (await c.get("/api/v1/summary")).body;
    assert.equal(s.total, 9_067_500 + 1_800_000 + 335_500 + 0 - 450_000 + 95_000);
    assert.equal(s.total, 10_848_000);
    assert.equal(s.assets, 11_298_000);
    assert.equal(s.debts, 450_000);
    assert.deepEqual(s.flow, { income: 5_000_000, expense: 50_000 + 5_000 + 2_500 + 30_000 });
    assert.deepEqual(s.recent.map((r: Row) => r.description ?? r.kind), ["Kopi", "Gaji November", "Transfer fee", "transfer_in", "transfer_out"]);
  });

  it("spending by category includes the transfer fee and shares add up", async () => {
    const { spendingByCategory: rows } = (await c.get("/api/v1/summary")).body;
    assert.deepEqual(rows.map((r: { name: string; amount: number }) => [r.name, r.amount]), [["Transportation", 55_000], ["Food & Drinks", 30_000], ["Financial & Fees", 2_500]]);
    assert.ok(Math.abs(rows.reduce((s: number, r: { share: number }) => s + r.share, 0) - 1) < 1e-9);
  });

  it("the account ledger lists newest first with the balance after each row", async () => {
    const res = await c.get(`/api/v1/accounts/${ids.myBCA}/ledger`);
    assert.equal(res.status, 200);
    const rows = res.body.items as Row[];
    assert.deepEqual(rows.map((r) => r.description ?? r.kind), ["Kopi", "Gaji November", "Transfer fee", "transfer_out", "Bensin"]);
    assert.deepEqual(rows.map((r) => r.runningBalance), [9_067_500, 9_097_500, 4_097_500, 4_100_000, 4_200_000]);
    assert.equal(rows[0].runningBalance, await balanceOf(c, ids.myBCA));
    assert.equal(res.body.nextCursor, null);
  });

  it("the ledger of the receiving account shows its own side", async () => {
    const rows = (await c.get(`/api/v1/accounts/${ids.GoPay}/ledger`)).body.items as Row[];
    assert.deepEqual(rows.map((r) => [r.kind, r.amount, r.runningBalance, r.counterpartName]), [["transfer_in", 100_000, 335_500, "myBCA"]]);
  });

  it("the month filter keeps running balances computed from the start", async () => {
    const nov = (await c.get(`/api/v1/accounts/${ids.myBCA}/ledger?month=2026-11`)).body.items as Row[];
    assert.equal(nov.length, 5);
    const day = (await c.get(`/api/v1/accounts/${ids.myBCA}/ledger?month=2026-10`)).body.items as Row[];
    assert.equal(day.length, 0);
    // Move one row into October and check the November rows keep the right balance.
    const bensin = nov.find((r) => r.description === "Bensin")!;
    assert.equal((await c.patch(`/api/v1/transactions/${bensin.id}`, { date: "2026-10-30" })).status, 200);
    const oct = (await c.get(`/api/v1/accounts/${ids.myBCA}/ledger?month=2026-10`)).body.items as Row[];
    const novAfter = (await c.get(`/api/v1/accounts/${ids.myBCA}/ledger?month=2026-11`)).body.items as Row[];
    assert.deepEqual(oct.map((r) => r.runningBalance), [4_200_000]);
    assert.deepEqual(novAfter.map((r) => r.runningBalance), [9_067_500, 9_097_500, 4_097_500, 4_100_000]);
    await c.patch(`/api/v1/transactions/${bensin.id}`, { date: "2026-11-17" });
  });

  it("search is case-insensitive and covers description, category and account name", async () => {
    assert.equal((await all(c, "q=KOPI")).length, 1);
    assert.equal((await all(c, "q=food")).length, 1);
    assert.equal((await all(c, "q=mybca")).length, 5);
    assert.equal((await all(c, "q=nothing-matches")).length, 0);
  });

  it("search treats % and _ as plain characters", async () => {
    const tx = await c.post("/api/v1/transactions", expense(ids.Celengan, 1_000, "2026-11-19", { description: "Diskon 50% asli_ok" }));
    assert.equal(tx.status, 201);
    assert.equal((await all(c, "q=%25")).length, 1);
    assert.equal((await all(c, "q=_")).length, 1);
    assert.equal((await all(c, "q=50%25 asli")).length, 1);
    await c.del(`/api/v1/transactions/${tx.body.transaction.id}`);
    assert.equal((await all(c, "q=%25")).length, 0);
  });

  it("filters by kind, account and date range, alone and together", async () => {
    assert.equal((await all(c)).length, 7);
    assert.equal((await all(c, "kind=transfer")).length, 2);
    assert.equal((await all(c, "kind=expense")).length, 4); // bensin, parkir, fee, kopi
    assert.equal((await all(c, "kind=income")).length, 1);
    assert.equal((await all(c, "kind=adjustment")).length, 0);
    assert.equal((await all(c, `account=${ids.GoPay}`)).length, 1);
    assert.equal((await all(c, "from=2026-11-18&to=2026-11-18")).length, 3);
    assert.equal((await all(c, "from=2026-11-19")).length, 2);
    assert.equal((await all(c, "to=2026-11-17")).length, 2);
    assert.deepEqual((await all(c, `kind=expense&account=${ids.myBCA}&from=2026-11-18`)).map((r) => r.description), ["Kopi", "Transfer fee"]);
  });

  it("rejects malformed filters", async () => {
    for (const q of ["kind=bogus", "from=2026-13-40", "to=yesterday", "limit=0", "limit=201", "limit=abc", "account=not-a-uuid"]) {
      const res = await c.get(`/api/v1/transactions?${q}`);
      assert.equal(res.status, 400, q);
      assert.equal(res.body.error.code, "validation");
    }
    // Empty values are treated as "not set", so a form can send all fields.
    assert.equal((await c.get("/api/v1/transactions?q=&kind=&from=&to=&account=")).status, 200);
  });

  it("pages through everything with a cursor: no gaps, no repeats, same order", async () => {
    const full = (await all(c)).map((r) => r.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: { body: { items: Row[]; nextCursor: string | null } } = await c.get(`/api/v1/transactions?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...res.body.items.map((r) => r.id));
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor && pages < 20);
    assert.deepEqual(seen, full);
    assert.equal(pages, 4);
  });

  it("ledger paging keeps running balances identical to the single page", async () => {
    const full = (await c.get(`/api/v1/accounts/${ids.myBCA}/ledger`)).body.items as Row[];
    const got: Row[] = [];
    let cursor: string | null = null;
    do {
      const res: { body: { items: Row[]; nextCursor: string | null } } = await c.get(`/api/v1/accounts/${ids.myBCA}/ledger?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      got.push(...res.body.items);
      cursor = res.body.nextCursor;
    } while (cursor);
    assert.deepEqual(got.map((r) => [r.id, r.runningBalance]), full.map((r) => [r.id, r.runningBalance]));
  });

  it("a forged or broken cursor is a 400, never a database error", async () => {
    const forged = Buffer.from(JSON.stringify({ date: "2026-11-19", createdAt: "x'; drop table transactions; --", id: "00000000-0000-4000-8000-000000000000" })).toString("base64url");
    for (const cursor of ["garbage", forged, Buffer.from("{}").toString("base64url")]) {
      for (const path of ["/api/v1/transactions", `/api/v1/accounts/${ids.myBCA}/ledger`]) {
        const res = await c.get(`${path}?cursor=${cursor}`);
        assert.deepEqual([res.status, res.body.error.code], [400, "invalid_cursor"], `${path} ${cursor.slice(0, 10)}`);
      }
    }
    assert.equal((await all(c)).length, 7);
  });

  it("single transaction lookup", async () => {
    const [kopi] = await all(c, "q=kopi");
    const res = await c.get(`/api/v1/transactions/${kopi.id}`);
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.transaction.description, res.body.transaction.amount, res.body.transaction.date], ["Kopi", -30_000, "2026-11-19"]);
    assert.equal((await c.get("/api/v1/transactions/00000000-0000-4000-8000-000000000000")).status, 404);
    assert.equal((await c.get("/api/v1/transactions/xyz")).status, 404);
  });
});

describe("rows with identical timestamps", () => {
  let ctx: TestContext;
  let c: Client;
  let ids: Ids;
  before(async () => {
    ctx = await createContext();
    c = await ctx.signUp("ties@example.com");
    ids = await seedAccounts(c);
    const userId = (await c.get("/api/v1/me")).body.user.id;
    // Six rows with the same date and created_at: only the id can order them.
    for (const amount of [-1, -2, -3, -4, -5, -6]) {
      await ctx.db.execute(sql`insert into transactions (user_id, account_id, kind, amount, date, created_at)
        values (${userId}, ${ids.myBCA}, 'expense', ${amount}, '2026-11-10', '2026-11-10 10:00:00+00')`);
    }
  });
  after(async () => ctx.close());

  it("list paging returns each row exactly once", async () => {
    const full = (await all(c)).map((r) => r.id);
    assert.equal(full.length, 6);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res: { body: { items: Row[]; nextCursor: string | null } } = await c.get(`/api/v1/transactions?limit=1${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...res.body.items.map((r) => r.id));
      cursor = res.body.nextCursor;
    } while (cursor);
    assert.deepEqual(seen, full);
  });

  it("ledger paging returns each row once and the balances still step by the amounts", async () => {
    const got: Row[] = [];
    let cursor: string | null = null;
    do {
      const res: { body: { items: Row[]; nextCursor: string | null } } = await c.get(`/api/v1/accounts/${ids.myBCA}/ledger?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      got.push(...res.body.items);
      cursor = res.body.nextCursor;
    } while (cursor);
    assert.equal(new Set(got.map((r) => r.id)).size, 6);
    // Newest first: each row's balance is the next row's balance plus that row's amount.
    for (let i = 0; i < got.length - 1; i++) assert.equal(got[i].runningBalance, got[i + 1].runningBalance! + got[i].amount);
    assert.equal(got[0].runningBalance, 4_250_000 - 21);
  });
});

describe("editing and deleting", () => {
  let ctx: TestContext;
  let c: Client;
  let ids: Ids;
  let food: string, salary: string;
  before(async () => {
    ctx = await createContext();
    c = await ctx.signUp("edit@example.com");
    ids = await seedAccounts(c);
    food = await categoryId(c, "Food & Drinks", "expense");
    salary = await categoryId(c, "Salary", "income");
  });
  after(async () => ctx.close());

  async function make(over: Record<string, unknown> = {}) {
    const res = await c.post("/api/v1/transactions", expense(ids.myBCA, 25_000, "2026-11-19", { categoryId: food, description: "Kopi", ...over }));
    assert.equal(res.status, 201);
    return res.body.transaction as Row;
  }

  it("changing the amount recalculates the balance", async () => {
    const t = await make();
    assert.equal(await balanceOf(c, ids.myBCA), 4_225_000);
    const res = await c.patch(`/api/v1/transactions/${t.id}`, { amount: 30_000 });
    assert.deepEqual([res.status, res.body.transaction.amount], [200, -30_000]);
    assert.equal(await balanceOf(c, ids.myBCA), 4_220_000);
    await c.del(`/api/v1/transactions/${t.id}`);
  });

  it("turning an expense into income flips the sign, and a mismatched category is refused", async () => {
    const t = await make();
    const bad = await c.patch(`/api/v1/transactions/${t.id}`, { kind: "income" });
    assert.deepEqual([bad.status, bad.body.error.code], [400, "invalid_category"]);
    assert.equal(await balanceOf(c, ids.myBCA), 4_225_000);
    const ok = await c.patch(`/api/v1/transactions/${t.id}`, { kind: "income", categoryId: salary });
    assert.deepEqual([ok.status, ok.body.transaction.amount, ok.body.transaction.categoryName], [200, 25_000, "Salary"]);
    assert.equal(await balanceOf(c, ids.myBCA), 4_275_000);
    await c.del(`/api/v1/transactions/${t.id}`);
  });

  it("moving to another account, clearing text, and changing the date", async () => {
    const t = await make({ note: "catatan" });
    const res = await c.patch(`/api/v1/transactions/${t.id}`, { accountId: ids["BYOND by BSI"], description: null, note: null, date: "2026-11-05" });
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.transaction.accountName, res.body.transaction.description, res.body.transaction.note, res.body.transaction.date], ["BYOND by BSI", null, null, "2026-11-05"]);
    assert.equal(await balanceOf(c, ids.myBCA), 4_250_000);
    assert.equal(await balanceOf(c, ids["BYOND by BSI"]), 1_775_000);
    await c.del(`/api/v1/transactions/${t.id}`);
  });

  it("refuses empty or invalid edits, and editing into an archived account", async () => {
    const t = await make();
    assert.equal((await c.patch(`/api/v1/transactions/${t.id}`, {})).status, 400);
    assert.equal((await c.patch(`/api/v1/transactions/${t.id}`, { amount: 0 })).status, 400);
    assert.equal((await c.patch(`/api/v1/transactions/${t.id}`, { date: "2026-02-31" })).status, 400);
    await c.post(`/api/v1/accounts/${ids.Celengan}/archive`);
    const res = await c.patch(`/api/v1/transactions/${t.id}`, { accountId: ids.Celengan });
    assert.deepEqual([res.status, res.body.error.code], [400, "account_unavailable"]);
    await c.post(`/api/v1/accounts/${ids.Celengan}/restore`);
    await c.del(`/api/v1/transactions/${t.id}`);
  });

  it("transfer legs and adjustments cannot be edited", async () => {
    const tr = await c.post("/api/v1/transfers", { fromAccountId: ids.myBCA, toAccountId: ids.GoPay, amount: 1_000, fee: 100, date: "2026-11-19" });
    for (const row of tr.body.rows as Row[]) {
      const res = await c.patch(`/api/v1/transactions/${row.id}`, { amount: 5 });
      assert.deepEqual([res.status, res.body.error.code], [400, "transfer_locked"], row.kind);
    }
    const adj = await c.post(`/api/v1/accounts/${ids.myBCA}/balance-checks`, { actualBalance: 1_000_000, date: "2026-11-19" });
    const res = await c.patch(`/api/v1/transactions/${adj.body.adjustmentId}`, { amount: 5 });
    assert.deepEqual([res.status, res.body.error.code], [400, "adjustment_locked"]);
    await c.del(`/api/v1/transactions/${tr.body.rows[0].id}`);
    await c.del(`/api/v1/transactions/${adj.body.adjustmentId}`);
    assert.equal(await balanceOf(c, ids.myBCA), 4_250_000);
  });

  it("deleting a transfer from any of its rows removes all of them", async () => {
    for (const pick of [0, 1, 2]) {
      const tr = await c.post("/api/v1/transfers", { fromAccountId: ids.myBCA, toAccountId: ids.GoPay, amount: 100_000, fee: 2_500, date: "2026-11-19" });
      const rows = tr.body.rows as Row[];
      assert.equal(await balanceOf(c, ids.myBCA), 4_250_000 - 102_500);
      assert.equal((await c.del(`/api/v1/transactions/${rows[pick].id}`)).status, 204);
      for (const r of rows) assert.equal((await c.get(`/api/v1/transactions/${r.id}`)).status, 404, `row ${r.kind} after deleting #${pick}`);
      assert.equal(await balanceOf(c, ids.myBCA), 4_250_000);
      assert.equal(await balanceOf(c, ids.GoPay), 235_500);
    }
  });

  it("deleting twice, or deleting nothing, is a 404", async () => {
    const t = await make();
    assert.equal((await c.del(`/api/v1/transactions/${t.id}`)).status, 204);
    assert.equal((await c.del(`/api/v1/transactions/${t.id}`)).status, 404);
    assert.equal((await c.del("/api/v1/transactions/nope")).status, 404);
  });

  it("deleting an adjustment keeps the balance check but unlinks it", async () => {
    const adj = await c.post(`/api/v1/accounts/${ids.myBCA}/balance-checks`, { actualBalance: 4_000_000, date: "2026-11-19" });
    assert.equal(adj.body.difference, -250_000);
    assert.equal((await c.del(`/api/v1/transactions/${adj.body.adjustmentId}`)).status, 204);
    assert.equal(await balanceOf(c, ids.myBCA), 4_250_000);
    const rows = (await ctx.db.execute(sql`select actual_balance::bigint as actual, difference::bigint as diff, adjustment_transaction_id as adj from balance_checks where actual_balance = 4000000`)) as unknown as { actual: string; diff: string; adj: string | null }[];
    assert.deepEqual([rows.length, Number(rows[0].actual), Number(rows[0].diff), rows[0].adj], [1, 4_000_000, -250_000, null]);
    // Every check made earlier in this file is also unlinked now that its adjustment is gone.
    const linked = (await ctx.db.execute(sql`select count(*)::int as n from balance_checks b join transactions t on t.id = b.adjustment_transaction_id`)) as unknown as { n: number }[];
    assert.equal(linked[0].n, 0);
  });
});

describe("input validation", () => {
  let ctx: TestContext;
  let c: Client;
  let ids: Ids;
  before(async () => {
    ctx = await createContext();
    c = await ctx.signUp("valid@example.com");
    ids = await seedAccounts(c);
  });
  after(async () => ctx.close());

  it("rejects bad transaction bodies with a clear message", async () => {
    const ok = expense(ids.myBCA, 1_000, "2026-11-19");
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ ...ok, amount: 0 }, /greater than 0/],
      [{ ...ok, amount: -5 }, /greater than 0/],
      [{ ...ok, description: "a\u0000b" }, /not allowed/],
      [{ ...ok, note: "a\u0000b" }, /not allowed/],
      [{ ...ok, amount: 1.5 }, /./],
      [{ ...ok, amount: "25000" }, /./],
      [{ ...ok, amount: 1_000_000_000_000 }, /too large/],
      [{ ...ok, date: "19-11-2026" }, /Invalid date/],
      [{ ...ok, date: "2026-02-31" }, /Invalid date/],
      [{ ...ok, kind: "transfer_out" }, /./],
      [{ ...ok, kind: "adjustment" }, /./],
      [{ ...ok, accountId: "nope" }, /Invalid data/],
      [{ ...ok, description: "x".repeat(121) }, /Maximum 120/],
      [{ ...ok, note: "x".repeat(501) }, /Maximum 500/],
      [{ ...ok, categoryId: undefined }, /./],
    ];
    for (const [body, message] of cases) {
      const res = await c.post("/api/v1/transactions", body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(res.body.error.message, message);
    }
  });

  it("refuses an unknown account and a category of the wrong kind", async () => {
    const ghost = await c.post("/api/v1/transactions", expense("00000000-0000-4000-8000-000000000000", 1_000, "2026-11-19"));
    assert.deepEqual([ghost.status, ghost.body.error.code], [400, "account_unavailable"]);
    const salary = await categoryId(c, "Salary", "income");
    const wrong = await c.post("/api/v1/transactions", expense(ids.myBCA, 1_000, "2026-11-19", { categoryId: salary }));
    assert.deepEqual([wrong.status, wrong.body.error.code], [400, "invalid_category"]);
    const unknown = await c.post("/api/v1/transactions", expense(ids.myBCA, 1_000, "2026-11-19", { categoryId: "00000000-0000-4000-8000-000000000000" }));
    assert.deepEqual([unknown.status, unknown.body.error.code], [400, "invalid_category"]);
    assert.equal(await balanceOf(c, ids.myBCA), 4_250_000);
  });

  it("trims text and stores empty text as null", async () => {
    const res = await c.post("/api/v1/transactions", expense(ids.myBCA, 1_000, "2026-11-19", { description: "  Kopi susu  ", note: "   " }));
    assert.equal(res.status, 201);
    assert.deepEqual([res.body.transaction.description, res.body.transaction.note], ["Kopi susu", null]);
  });

  it("rejects bad transfers and keeps all balances unchanged", async () => {
    const base = { fromAccountId: ids.myBCA, toAccountId: ids.GoPay, amount: 1_000, fee: 0, date: "2026-11-19" };
    const rowsBefore = (await all(c)).length;
    const bca = await balanceOf(c, ids.myBCA);
    const gopay = await balanceOf(c, ids.GoPay);
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ ...base, toAccountId: ids.myBCA }, /must differ/],
      [{ ...base, amount: 0 }, /greater than 0/],
      [{ ...base, fee: -1 }, /./],
      [{ ...base, fee: 1.5 }, /./],
      [{ ...base, date: "nope" }, /Invalid date/],
      [{ ...base, fromAccountId: "nope" }, /Invalid data/],
      [{ ...base, note: "x".repeat(201) }, /Maximum 200/],
    ];
    for (const [body, message] of cases) {
      const res = await c.post("/api/v1/transfers", body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(res.body.error.message, message);
    }
    await c.post(`/api/v1/accounts/${ids.GoPay}/archive`);
    const toArchived = await c.post("/api/v1/transfers", base);
    assert.deepEqual([toArchived.status, toArchived.body.error.code], [400, "account_unavailable"]);
    await c.post(`/api/v1/accounts/${ids.GoPay}/restore`);
    assert.equal(await balanceOf(c, ids.myBCA), bca);
    assert.equal(await balanceOf(c, ids.GoPay), gopay);
    assert.equal((await all(c)).length, rowsBefore);
  });

  it("a failed transfer leaves nothing behind", async () => {
    const count = async () => ((await ctx.db.execute(sql`select (select count(*) from transfers)::int as t, (select count(*) from transactions)::int as x`)) as unknown as { t: number; x: number }[])[0];
    const before = await count();
    const res = await c.post("/api/v1/transfers", { fromAccountId: ids.myBCA, toAccountId: "00000000-0000-4000-8000-000000000000", amount: 1_000, fee: 500, date: "2026-11-19" });
    assert.equal(res.status, 400);
    assert.deepEqual(await count(), before);
  });
});
