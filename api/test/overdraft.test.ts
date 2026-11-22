import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { sql } from "drizzle-orm";
import { balanceOf, categoryId, createContext, seedAccounts, type Client, type TestContext } from "./helpers";

type Ids = Awaited<ReturnType<typeof seedAccounts>>;

describe("each account keeps its own balance", () => {
  let ctx: TestContext;
  let c: Client;
  let ids: Ids;
  let food: string;
  let salary: string;

  const spend = (accountId: string, amount: number, date = "2026-11-10") => c.post("/api/v1/transactions", { kind: "expense", accountId, amount, date, categoryId: food, description: "Test" });
  const earn = (accountId: string, amount: number, date = "2026-11-10") => c.post("/api/v1/transactions", { kind: "income", accountId, amount, date, categoryId: salary, description: "Pay" });
  const move = (fromAccountId: string, toAccountId: string, amount: number, fee = 0) => c.post("/api/v1/transfers", { fromAccountId, toAccountId, amount, fee, date: "2026-11-10" });
  const balances = async () => ({
    bca: await balanceOf(c, ids.myBCA),
    bsi: await balanceOf(c, ids["BYOND by BSI"]),
    gopay: await balanceOf(c, ids.GoPay),
    dana: await balanceOf(c, ids.DANA),
    paylater: await balanceOf(c, ids.SPayLater),
    cash: await balanceOf(c, ids.Celengan),
  });

  before(async () => {
    ctx = await createContext();
    c = await ctx.signUp("overdraft@example.com");
    ids = await seedAccounts(c);
    food = await categoryId(c, "Food & Drinks", "expense");
    salary = await categoryId(c, "Salary", "income");
    // GoPay holds exactly Rp 300,000 while the other accounts hold much more.
    assert.equal((await c.patch(`/api/v1/accounts/${ids.GoPay}`, { initialBalance: 300_000 })).status, 200);
  });
  after(async () => ctx.close());

  it("refuses an expense bigger than the account balance and touches no other account", async () => {
    const before = await balances();
    const res = await spend(ids.GoPay, 400_000);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "insufficient_balance");
    assert.match(res.body.error.message, /GoPay/);
    assert.deepEqual(await balances(), before);
    const list = (await c.get(`/api/v1/transactions?account=${ids.GoPay}`)).body.items;
    assert.equal(list.length, 0, "nothing was booked");
  });

  it("allows spending exactly the balance, and then nothing more", async () => {
    assert.equal((await spend(ids.GoPay, 300_000)).status, 201);
    assert.equal(await balanceOf(c, ids.GoPay), 0);
    const res = await spend(ids.GoPay, 1);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "insufficient_balance");
    assert.equal(await balanceOf(c, ids.GoPay), 0);
  });

  it("other accounts keep spending normally", async () => {
    const before = await balances();
    assert.equal((await spend(ids.myBCA, 1_000_000)).status, 201);
    assert.deepEqual(await balances(), { ...before, bca: before.bca - 1_000_000 });
  });

  it("income makes room again", async () => {
    assert.equal((await earn(ids.GoPay, 500_000)).status, 201);
    assert.equal((await spend(ids.GoPay, 400_000)).status, 201);
    assert.equal(await balanceOf(c, ids.GoPay), 100_000);
  });

  it("a transfer cannot take more than the source holds, fee included", async () => {
    const before = await balances();
    for (const [amount, fee] of [[100_001, 0], [100_000, 1], [99_000, 2_000]] as const) {
      const res = await move(ids.GoPay, ids.DANA, amount, fee);
      assert.equal(res.status, 400, `${amount}+${fee}`);
      assert.equal(res.body.error.code, "insufficient_balance");
    }
    assert.deepEqual(await balances(), before);
    const none = (await c.get(`/api/v1/transactions?account=${ids.DANA}`)).body.items;
    assert.equal(none.length, 0, "no half-booked transfer");
  });

  it("a transfer moves money and is neither income nor expense", async () => {
    const flowBefore = (await c.get("/api/v1/stats/flow?period=month")).body;
    const before = await balances();
    const res = await move(ids.GoPay, ids.DANA, 60_000, 0);
    assert.equal(res.status, 201);
    assert.deepEqual(await balances(), { ...before, gopay: before.gopay - 60_000, dana: before.dana + 60_000 });
    const flowAfter = (await c.get("/api/v1/stats/flow?period=month")).body;
    assert.deepEqual(flowAfter, flowBefore);
    // The total does not change when money only moves between accounts.
    const total = (await c.get("/api/v1/summary?period=month")).body.total;
    assert.equal(total, Object.values(await balances()).reduce((s, v) => s + v, 0));
  });

  it("a transfer fee is an expense on the source only", async () => {
    const before = await balances();
    assert.equal((await move(ids.GoPay, ids.DANA, 30_000, 2_500)).status, 201);
    assert.deepEqual(await balances(), { ...before, gopay: before.gopay - 32_500, dana: before.dana + 30_000 });
  });

  it("a debt account (paylater) may go further into debt", async () => {
    const before = await balanceOf(c, ids.SPayLater);
    assert.equal((await spend(ids.SPayLater, 2_000_000)).status, 201);
    assert.equal(await balanceOf(c, ids.SPayLater), before - 2_000_000);
  });

  it("paying a bill from an account that is too low is refused", async () => {
    const before = await balances();
    const res = await move(ids.DANA, ids.SPayLater, 10_000_000);
    assert.equal(res.status, 400);
    assert.deepEqual(await balances(), before);
  });

  describe("editing", () => {
    it("raising an expense above the balance is refused and keeps the old amount", async () => {
      const made = await spend(ids.Celengan, 40_000);
      assert.equal(made.status, 201);
      const id = made.body.transaction.id as string;
      const res = await c.patch(`/api/v1/transactions/${id}`, { amount: 150_000 });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "insufficient_balance");
      assert.equal(await balanceOf(c, ids.Celengan), 60_000);
      assert.equal((await c.patch(`/api/v1/transactions/${id}`, { amount: 100_000 })).status, 200);
      assert.equal(await balanceOf(c, ids.Celengan), 0);
    });

    it("lowering an expense gives the money back", async () => {
      const list = (await c.get(`/api/v1/transactions?account=${ids.Celengan}&kind=expense`)).body.items;
      assert.equal((await c.patch(`/api/v1/transactions/${list[0].id}`, { amount: 30_000 })).status, 200);
      assert.equal(await balanceOf(c, ids.Celengan), 70_000);
    });

    it("moving an expense to an account that cannot afford it is refused, and both balances stay", async () => {
      const made = await spend(ids.myBCA, 500_000);
      const id = made.body.transaction.id as string;
      const before = await balances();
      const res = await c.patch(`/api/v1/transactions/${id}`, { accountId: ids.Celengan });
      assert.equal(res.status, 400);
      assert.deepEqual(await balances(), before);
    });

    it("moving an expense to an account that can afford it updates both balances", async () => {
      const list = (await c.get(`/api/v1/transactions?account=${ids.myBCA}&kind=expense`)).body.items;
      const big = list.find((r: { amount: number }) => r.amount === -500_000);
      const before = await balances();
      assert.equal((await c.patch(`/api/v1/transactions/${big.id}`, { accountId: ids["BYOND by BSI"] })).status, 200);
      assert.deepEqual(await balances(), { ...before, bca: before.bca + 500_000, bsi: before.bsi - 500_000 });
    });

    it("changing an income into an expense counts twice against the account", async () => {
      const made = await earn(ids.DANA, 100_000);
      const id = made.body.transaction.id as string;
      const dana = await balanceOf(c, ids.DANA);
      const res = await c.patch(`/api/v1/transactions/${id}`, { kind: "expense", categoryId: food, amount: 100_000 });
      assert.equal(dana - 200_000 < 0, true);
      assert.equal(res.status, 400);
      assert.equal(await balanceOf(c, ids.DANA), dana);
    });

    it("lowering an opening balance below what was spent is refused", async () => {
      const res = await c.patch(`/api/v1/accounts/${ids.Celengan}`, { initialBalance: 0 });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "insufficient_balance");
      assert.equal(await balanceOf(c, ids.Celengan), 70_000);
    });
  });

  describe("deleting", () => {
    it("deleting an income that was already spent is refused", async () => {
      const made = await earn(ids.Celengan, 200_000, "2026-11-11");
      const id = made.body.transaction.id as string;
      assert.equal((await spend(ids.Celengan, 250_000, "2026-11-12")).status, 201);
      const before = await balanceOf(c, ids.Celengan);
      const res = await c.del(`/api/v1/transactions/${id}`);
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "insufficient_balance");
      assert.equal(await balanceOf(c, ids.Celengan), before);
    });

    it("deleting an expense always gives the money back", async () => {
      const list = (await c.get(`/api/v1/transactions?account=${ids.Celengan}&kind=expense`)).body.items;
      const before = await balanceOf(c, ids.Celengan);
      assert.equal((await c.del(`/api/v1/transactions/${list[0].id}`)).status, 204);
      assert.equal(await balanceOf(c, ids.Celengan), before + Math.abs(list[0].amount));
    });

    it("deleting a transfer undoes both sides; refused when the target already spent it", async () => {
      const gopay = await balanceOf(c, ids.GoPay);
      const res = await move(ids.GoPay, ids.Celengan, 5_000);
      assert.equal(res.status, 201);
      const leg = res.body.rows.find((r: { kind: string }) => r.kind === "transfer_out");
      const cash = await balanceOf(c, ids.Celengan);
      assert.equal((await c.del(`/api/v1/transactions/${leg.id}`)).status, 204);
      assert.equal(await balanceOf(c, ids.GoPay), gopay);
      assert.equal(await balanceOf(c, ids.Celengan), cash - 5_000);

      // Money that arrived by transfer and was spent cannot be un-transferred.
      const again = await move(ids.myBCA, ids.DANA, 700_000);
      assert.equal(again.status, 201);
      const danaNow = await balanceOf(c, ids.DANA);
      assert.equal((await spend(ids.DANA, danaNow - 10_000)).status, 201);
      const out = again.body.rows.find((r: { kind: string }) => r.kind === "transfer_out");
      const refused = await c.del(`/api/v1/transactions/${out.id}`);
      assert.equal(refused.status, 400);
      assert.equal(refused.body.error.code, "insufficient_balance");
    });
  });

  it("older data that is already below zero is tolerated, but may not go lower", async () => {
    // Old versions allowed it, so write a balance of -50,000 straight into the database.
    const now = await balanceOf(c, ids.GoPay);
    await ctx.db.execute(sql`update money_accounts set initial_balance = initial_balance - ${now + 50_000} where id = ${ids.GoPay}`);
    assert.equal(await balanceOf(c, ids.GoPay), -50_000);
    assert.equal((await spend(ids.GoPay, 1)).status, 400, "no deeper");
    assert.equal((await earn(ids.GoPay, 20_000)).status, 201, "money in is fine");
    assert.equal(await balanceOf(c, ids.GoPay), -30_000);
    assert.equal((await c.patch(`/api/v1/accounts/${ids.GoPay}`, { name: "GoPay" })).status, 200, "unrelated edits still work");
  });

  it("the total is always the sum of the accounts", async () => {
    const accounts = (await c.get("/api/v1/accounts")).body.accounts as { balance: number; includeInTotal: boolean }[];
    const total = (await c.get("/api/v1/summary?period=month")).body.total as number;
    assert.equal(total, accounts.filter((a) => a.includeInTotal).reduce((s, a) => s + a.balance, 0));
  });
});
