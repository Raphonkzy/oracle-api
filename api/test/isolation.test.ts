import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { balanceOf, categoryId, createContext, seedAccounts, type Client, type TestContext } from "./helpers";

describe("one user can never touch another user's data", () => {
  let ctx: TestContext;
  let alice: Client;
  let bob: Client;
  let a: Awaited<ReturnType<typeof seedAccounts>>;
  let b: Awaited<ReturnType<typeof seedAccounts>>;
  let aliceTx: string;
  let aliceTransferLeg: string;
  let aliceFood: string;

  before(async () => {
    ctx = await createContext();
    alice = await ctx.signUp("alice@example.com", "Alice");
    bob = await ctx.signUp("bob@example.com", "Bob");
    a = await seedAccounts(alice);
    b = await seedAccounts(bob);
    aliceFood = await categoryId(alice, "Food & Drinks", "expense");
    aliceTx = (await alice.post("/api/v1/transactions", { kind: "expense", accountId: a.myBCA, amount: 25_000, date: "2026-11-19", categoryId: aliceFood, description: "Rahasia Alice" })).body.transaction.id;
    aliceTransferLeg = (await alice.post("/api/v1/transfers", { fromAccountId: a.myBCA, toAccountId: a.GoPay, amount: 1_000, fee: 0, date: "2026-11-19" })).body.rows[0].id;
  });
  after(async () => ctx.close());

  it("accounts are invisible: 404 on every route", async () => {
    for (const [method, path, body] of [
      ["GET", `/api/v1/accounts/${a.myBCA}`, undefined],
      ["PATCH", `/api/v1/accounts/${a.myBCA}`, { name: "Dibajak" }],
      ["POST", `/api/v1/accounts/${a.myBCA}/archive`, undefined],
      ["POST", `/api/v1/accounts/${a.myBCA}/restore`, undefined],
      ["GET", `/api/v1/accounts/${a.myBCA}/ledger`, undefined],
    ] as const) {
      const res = await bob.call(method, path, body);
      assert.equal(res.status, 404, `${method} ${path}`);
    }
  });

  it("transactions are invisible: read, edit and delete all give 404", async () => {
    assert.equal((await bob.get(`/api/v1/transactions/${aliceTx}`)).status, 404);
    assert.equal((await bob.patch(`/api/v1/transactions/${aliceTx}`, { amount: 1 })).status, 404);
    assert.equal((await bob.del(`/api/v1/transactions/${aliceTx}`)).status, 404);
    assert.equal((await bob.del(`/api/v1/transactions/${aliceTransferLeg}`)).status, 404);
  });

  it("Bob cannot book money on Alice's account, or move money in or out of it", async () => {
    const tx = await bob.post("/api/v1/transactions", { kind: "expense", accountId: a.myBCA, amount: 1_000, date: "2026-11-19", categoryId: null });
    assert.deepEqual([tx.status, tx.body.error.code], [400, "account_unavailable"]);
    for (const [from, to] of [[b.myBCA, a.myBCA], [a.myBCA, b.myBCA], [a.myBCA, a.GoPay]]) {
      const res = await bob.post("/api/v1/transfers", { fromAccountId: from, toAccountId: to, amount: 1_000, fee: 0, date: "2026-11-19" });
      assert.deepEqual([res.status, res.body.error.code], [400, "account_unavailable"]);
    }
    const check = await bob.post(`/api/v1/accounts/${a.myBCA}/balance-checks`, { actualBalance: 1, date: "2026-11-19" });
    assert.deepEqual([check.status, check.body.error.code], [400, "account_unavailable"]);
  });

  it("Bob cannot use Alice's category, and moving his transaction to her account fails", async () => {
    const res = await bob.post("/api/v1/transactions", { kind: "expense", accountId: b.myBCA, amount: 1_000, date: "2026-11-19", categoryId: aliceFood });
    assert.deepEqual([res.status, res.body.error.code], [400, "invalid_category"]);
    const mine = await bob.post("/api/v1/transactions", { kind: "expense", accountId: b.myBCA, amount: 1_000, date: "2026-11-19", categoryId: null });
    const move = await bob.patch(`/api/v1/transactions/${mine.body.transaction.id}`, { accountId: a.myBCA });
    assert.deepEqual([move.status, move.body.error.code], [400, "account_unavailable"]);
    const steal = await bob.patch(`/api/v1/transactions/${mine.body.transaction.id}`, { categoryId: aliceFood });
    assert.deepEqual([steal.status, steal.body.error.code], [400, "invalid_category"]);
  });

  it("Bob cannot reorder with Alice's account ids", async () => {
    const mine = (await bob.get("/api/v1/accounts")).body.accounts.map((x: { id: string }) => x.id) as string[];
    const res = await bob.post("/api/v1/accounts/reorder", { ids: [...mine.slice(0, -1), a.myBCA] });
    assert.deepEqual([res.status, res.body.error.code], [400, "invalid_order"]);
  });

  it("lists, searches, ledgers, summaries and categories only ever show your own data", async () => {
    const bobTx = (await bob.get("/api/v1/transactions?limit=200")).body.items as { description: string | null; accountId: string }[];
    assert.ok(bobTx.every((t) => Object.values(b).includes(t.accountId)));
    assert.equal((await bob.get("/api/v1/transactions?q=Rahasia")).body.items.length, 0);
    assert.equal((await bob.get(`/api/v1/transactions?account=${a.myBCA}`)).body.items.length, 0);

    const bobAccounts = (await bob.get("/api/v1/accounts")).body.accounts as { id: string }[];
    assert.deepEqual(new Set(bobAccounts.map((x) => x.id)), new Set(Object.values(b)));

    const summary = (await bob.get("/api/v1/summary")).body;
    assert.equal(summary.total, 5_935_500 - 1_000); // Bob booked one 1.000 expense of his own earlier
    assert.ok(summary.recent.every((r: { accountId: string }) => Object.values(b).includes(r.accountId)));

    const aliceCats = new Set(((await alice.get("/api/v1/categories")).body.categories as { id: string }[]).map((x) => x.id));
    const bobCats = ((await bob.get("/api/v1/categories")).body.categories as { id: string }[]).map((x) => x.id);
    assert.ok(bobCats.every((id) => !aliceCats.has(id)));
  });

  it("a cursor taken from Alice's list cannot be used to read Alice's rows as Bob", async () => {
    const page = await alice.get("/api/v1/transactions?limit=1");
    assert.ok(page.body.nextCursor);
    const asBob = await bob.get(`/api/v1/transactions?limit=50&cursor=${page.body.nextCursor}`);
    assert.equal(asBob.status, 200);
    assert.ok(!asBob.body.items.some((r: { description: string | null }) => r.description === "Rahasia Alice"));
  });

  it("after all of that, Alice's data is exactly as she left it", async () => {
    assert.equal(await balanceOf(alice, a.myBCA), 4_250_000 - 25_000 - 1_000);
    assert.equal(await balanceOf(alice, a.GoPay), 235_500 + 1_000);
    const tx = await alice.get(`/api/v1/transactions/${aliceTx}`);
    assert.deepEqual([tx.status, tx.body.transaction.amount, tx.body.transaction.description], [200, -25_000, "Rahasia Alice"]);
    const acc = (await alice.get(`/api/v1/accounts/${a.myBCA}`)).body.account;
    assert.deepEqual([acc.name, acc.archivedAt], ["myBCA", null]);
  });
});
