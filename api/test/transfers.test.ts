import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { balanceOf, createContext, seedAccounts, type Client, type TestContext } from "./helpers";

type Ids = Awaited<ReturnType<typeof seedAccounts>>;
type Row = { id: string; kind: string; amount: number; accountId: string; note: string | null; transferId: string | null };

describe("PATCH and DELETE /transfers/:id", () => {
  let ctx: TestContext;
  let c: Client;
  let other: Client;
  let ids: Ids;
  const missing = "00000000-0000-4000-8000-000000000000";

  before(async () => {
    ctx = await createContext();
    c = await ctx.signUp("transfers@example.com");
    other = await ctx.signUp("transfers-other@example.com");
    ids = await seedAccounts(c);
  });
  after(async () => ctx.close());

  const balances = async () => [await balanceOf(c, ids.myBCA), await balanceOf(c, ids["BYOND by BSI"]), await balanceOf(c, ids.GoPay), await balanceOf(c, ids.DANA)];
  const make = async (body: Record<string, unknown> = {}) => {
    const res = await c.post("/api/v1/transfers", { fromAccountId: ids.myBCA, toAccountId: ids["BYOND by BSI"], amount: 100_000, fee: 2_500, date: "2026-11-10", note: "Rent", ...body });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const rows = res.body.rows as Row[];
    return { id: rows[0].transferId as string, rows };
  };
  const path = (id: string) => `/api/v1/transfers/${id}`;

  describe("PATCH", () => {
    it("changes the amount on both legs and the balances match", async () => {
      const start = await balances();
      const { id } = await make();
      const res = await c.patch(path(id), { amount: 150_000 });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const rows = res.body.rows as Row[];
      assert.deepEqual(rows.map((r) => r.amount), [-150_000, 150_000, -2_500]);
      const [bca, bsi] = await balances();
      assert.equal(bca, start[0] - 150_000 - 2_500);
      assert.equal(bsi, start[1] + 150_000);
    });

    it("keeps the fee row and the note when only the amount changes", async () => {
      const { id } = await make();
      const res = await c.patch(path(id), { amount: 90_000 });
      assert.equal(res.status, 200);
      const rows = res.body.rows as Row[];
      assert.equal(rows.length, 3);
      assert.equal(rows[2].amount, -2_500);
      assert.equal(rows[0].note, "Rent");
      assert.equal(rows[1].note, "Rent");
    });

    it("clears the note with null", async () => {
      const { id } = await make();
      const res = await c.patch(path(id), { note: null });
      assert.equal(res.status, 200);
      assert.deepEqual((res.body.rows as Row[]).map((r) => r.note), [null, null, null]);
    });

    it("removes the fee row with fee 0 and adds it back with a positive fee", async () => {
      const start = await balances();
      const { id } = await make({ amount: 50_000 });
      const none = await c.patch(path(id), { fee: 0 });
      assert.equal(none.status, 200);
      assert.deepEqual((none.body.rows as Row[]).map((r) => r.kind), ["transfer_out", "transfer_in"]);
      assert.equal((await balances())[0], start[0] - 50_000);
      const back = await c.patch(path(id), { fee: 1_000 });
      assert.equal(back.status, 200);
      assert.deepEqual((back.body.rows as Row[]).map((r) => [r.kind, r.amount]), [["transfer_out", -50_000], ["transfer_in", 50_000], ["expense", -1_000]]);
      assert.equal((await balances())[0], start[0] - 51_000);
    });

    it("moves a transfer to other accounts", async () => {
      const start = await balances();
      const { id } = await make({ fee: 0, amount: 10_000 });
      const res = await c.patch(path(id), { fromAccountId: ids["BYOND by BSI"], toAccountId: ids.DANA });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const [bca, bsi, , dana] = await balances();
      assert.equal(bca, start[0]);
      assert.equal(bsi, start[1] - 10_000);
      assert.equal(dana, start[3] + 10_000);
    });

    it("refuses the same account on both sides", async () => {
      const { id } = await make();
      const res = await c.patch(path(id), { toAccountId: ids.myBCA });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "validation");
    });

    it("refuses an empty body", async () => {
      const { id } = await make();
      const res = await c.patch(path(id), {});
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "validation");
      assert.equal(res.body.error.message, "Nothing to change.");
    });

    it("refuses an archived account", async () => {
      const { id } = await make();
      const spare = (await c.post("/api/v1/accounts", { name: "Spare", type: "cash", initialBalance: 0, initialBalanceDate: "2026-11-01", includeInTotal: true, providerId: null })).body.account.id as string;
      assert.equal((await c.post(`/api/v1/accounts/${spare}/archive`)).status, 200);
      const res = await c.patch(path(id), { toAccountId: spare });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "account_unavailable");
    });

    it("refuses an overdraft and leaves the balances as they were", async () => {
      const { id } = await make({ fee: 0, amount: 10_000 });
      const before = await balances();
      const res = await c.patch(path(id), { amount: 900_000_000 });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "insufficient_balance");
      assert.deepEqual(await balances(), before);
      const rows = (await c.get(`/api/v1/transactions?kind=transfer&limit=200`)).body.items as Row[];
      assert.equal(rows.filter((r) => r.transferId === id).length, 2);
    });

    it("gives 404 for a foreign, missing or non-UUID id", async () => {
      const { id } = await make();
      for (const target of [id, missing, "not-a-uuid"]) {
        const res = await other.patch(path(target), { amount: 1_000 });
        assert.equal(res.status, 404, target);
        assert.equal(res.body.error.code, "not_found");
      }
      assert.equal((await c.patch(path(missing), { amount: 1_000 })).status, 404);
    });
  });

  describe("DELETE and auth", () => {
    it("removes both legs and the fee row and restores the balances", async () => {
      const start = await balances();
      const { id, rows } = await make();
      const res = await c.del(path(id));
      assert.equal(res.status, 204);
      assert.deepEqual(await balances(), start);
      for (const r of rows) assert.equal((await c.get(`/api/v1/transactions/${r.id}`)).status, 404);
    });

    it("refuses a delete that would overdraw the receiving account", async () => {
      const { id } = await make({ fromAccountId: ids.myBCA, toAccountId: ids.DANA, amount: 200_000, fee: 0 });
      const spend = await c.post("/api/v1/transactions", { kind: "expense", accountId: ids.DANA, amount: 150_000, date: "2026-11-11", categoryId: null, description: "Spend" });
      assert.equal(spend.status, 201, JSON.stringify(spend.body));
      const before = await balances();
      const res = await c.del(path(id));
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "insufficient_balance");
      assert.deepEqual(await balances(), before);
    });

    it("gives 401 without a session", async () => {
      const { id } = await make();
      assert.equal((await ctx.anonymous.patch(path(id), { amount: 1_000 })).status, 401);
      assert.equal((await ctx.anonymous.del(path(id))).status, 401);
    });

    it("gives 404 for a foreign or missing id", async () => {
      const { id } = await make();
      assert.equal((await other.del(path(id))).status, 404);
      assert.equal((await c.del(path(missing))).status, 404);
      assert.equal((await c.del(path("not-a-uuid"))).status, 404);
      assert.equal((await c.del(path(id))).status, 204);
    });

    it("keeps the leg routes: PATCH is locked and DELETE removes the whole transfer", async () => {
      const start = await balances();
      const { id, rows } = await make();
      const patch = await c.patch(`/api/v1/transactions/${rows[0].id}`, { amount: 1_000 });
      assert.equal(patch.status, 400);
      assert.equal(patch.body.error.code, "transfer_locked");
      assert.equal((await c.del(`/api/v1/transactions/${rows[0].id}`)).status, 204);
      assert.deepEqual(await balances(), start);
      assert.equal((await c.del(path(id))).status, 404);
    });
  });
});
