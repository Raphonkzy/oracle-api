import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { categoryId, createContext, type Client, type TestContext } from "./helpers";

const BOM = "\uFEFF";
const HEADER = "Date,Account,Type,Category,Description,Note,Counterpart account,Amount (IDR)";

describe("CSV export", () => {
  let ctx: TestContext;
  let c: Client;
  let bca: string;
  let gopay: string;
  let food: string;
  let salary: string;

  /** The raw response, because the helper only reads JSON. */
  const raw = async (client: Client, path: string) => {
    const res = await ctx.app.request(path, { headers: { cookie: client.cookie, origin: "http://localhost:3200" } });
    const bytes = new Uint8Array(await res.arrayBuffer());
    // text() would drop the byte order mark, so the bytes are kept for checking it.
    return { status: res.status, headers: res.headers, bytes, text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) };
  };
  const lines = (text: string) => text.replace(BOM, "").split("\r\n").filter(Boolean);

  before(async () => {
    ctx = await createContext({ now: "2026-11-19T05:00:00Z" });
    c = await ctx.signUp("export@example.com");
    const a = await c.post("/api/v1/accounts", { providerId: "bca", name: "myBCA", type: "bank", initialBalance: 1_000_000, initialBalanceDate: "2026-11-01", includeInTotal: true });
    const b = await c.post("/api/v1/accounts", { providerId: "gopay", name: "GoPay", type: "ewallet", initialBalance: 0, initialBalanceDate: "2026-11-01", includeInTotal: true });
    bca = a.body.account.id;
    gopay = b.body.account.id;
    food = await categoryId(c, "Food & Drinks", "expense");
    salary = await categoryId(c, "Salary", "income");
    const post = (body: object) => c.post("/api/v1/transactions", body);
    assert.equal((await post({ kind: "income", accountId: bca, amount: 5_000_000, date: "2026-11-02", categoryId: salary, description: "November salary" })).status, 201);
    assert.equal((await post({ kind: "expense", accountId: bca, amount: 30_000, date: "2026-11-10", categoryId: food, description: "Coffee, large", note: 'He said "yes"\nthen left' })).status, 201);
    assert.equal((await post({ kind: "expense", accountId: bca, amount: 12_000, date: "2026-11-12", categoryId: food, description: "=HYPERLINK(\"http://evil\")" })).status, 201);
    assert.equal((await c.post("/api/v1/transfers", { fromAccountId: bca, toAccountId: gopay, amount: 100_000, fee: 2_500, date: "2026-11-15", note: "Top up" })).status, 201);
    assert.equal((await c.post(`/api/v1/accounts/${gopay}/balance-checks`, { actualBalance: 120_000, date: "2026-11-16" })).status, 201);
  });
  after(async () => ctx.close());

  it("sends a CSV file with the right headers and a byte order mark", async () => {
    const r = await raw(c, "/api/v1/export/transactions.csv");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "text/csv; charset=utf-8");
    assert.equal(r.headers.get("content-disposition"), 'attachment; filename="oracle-transactions-2026-11-19.csv"');
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.deepEqual([...r.bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 byte order mark, so Excel reads accents correctly");
    assert.ok(r.text.startsWith(BOM + HEADER + "\r\n"));
    assert.ok(r.text.endsWith("\r\n"));
  });

  it("lists everything oldest first with signed amounts, labels and counterparts", async () => {
    const rows = lines((await raw(c, "/api/v1/export/transactions.csv")).text);
    assert.equal(rows[0], HEADER);
    assert.equal(rows.length, 1 + 7, "header, salary, coffee, link, transfer out and in, fee, adjustment");
    assert.equal(rows[1], "2026-11-02,myBCA,Income,Salary,November salary,,,5000000");
    // The coffee row has a comma, quotes and a line break inside its fields. All of it must survive inside quotes.
    const coffee = rows.find((l) => l.startsWith("2026-11-10,"));
    assert.equal(coffee, '2026-11-10,myBCA,Expense,Food & Drinks,"Coffee, large","He said ""yes""\nthen left",,-30000');
    const dates = rows.filter((l) => /^\d{4}-/.test(l)).map((l) => l.slice(0, 10));
    assert.deepEqual(dates, [...dates].sort());
  });

  it("defuses text that would run as a formula in a spreadsheet", async () => {
    const text = (await raw(c, "/api/v1/export/transactions.csv")).text;
    assert.ok(text.includes(`"'=HYPERLINK(""http://evil"")"`), "the description starts with an apostrophe");
    assert.ok(!/,=HYPERLINK/.test(text) && !/,"=HYPERLINK/.test(text));
    assert.ok(text.includes(",-12000\r\n"), "numbers stay numbers");
  });

  it("writes both sides of a transfer, its fee, and the balance adjustment", async () => {
    const text = (await raw(c, "/api/v1/export/transactions.csv")).text;
    assert.ok(text.includes("2026-11-15,myBCA,Transfer out,,,Top up,GoPay,-100000"));
    assert.ok(text.includes("2026-11-15,GoPay,Transfer in,,,Top up,myBCA,100000"));
    assert.ok(text.includes("2026-11-15,myBCA,Transfer fee,Financial & Fees,Transfer fee,,,-2500"));
    assert.ok(text.includes("2026-11-16,GoPay,Balance adjustment,,Balance adjustment,,,20000"));
  });

  it("applies the same filters as the transaction list", async () => {
    const byAccount = lines((await raw(c, `/api/v1/export/transactions.csv?account=${gopay}`)).text);
    assert.deepEqual(byAccount.slice(1).map((l) => l.split(",")[1]), ["GoPay", "GoPay"]);
    const range = lines((await raw(c, "/api/v1/export/transactions.csv?from=2026-11-10&to=2026-11-12")).text);
    assert.equal(range.filter((l) => /^\d{4}-/.test(l)).length, 2);
    const search = lines((await raw(c, "/api/v1/export/transactions.csv?q=salary")).text);
    assert.equal(search.length, 2);
    const none = lines((await raw(c, "/api/v1/export/transactions.csv?q=zzz-nothing")).text);
    assert.deepEqual(none, [HEADER], "no match still gives a valid file");
  });

  it("exports more than one page of rows", async () => {
    const big = await ctx.signUp("big-export@example.com");
    const acc = await big.post("/api/v1/accounts", { providerId: null, name: "Cash", type: "cash", initialBalance: 0, initialBalanceDate: "2026-11-01", includeInTotal: true });
    const cat = await categoryId(big, "Salary", "income");
    for (let i = 0; i < 230; i += 1) {
      const res = await big.post("/api/v1/transactions", { kind: "income", accountId: acc.body.account.id, amount: 1_000 + i, date: "2026-11-05", categoryId: cat, description: `Row ${i}` });
      assert.equal(res.status, 201);
    }
    const rows = lines((await raw(big, "/api/v1/export/transactions.csv")).text);
    assert.equal(rows.length, 231, "230 rows plus the header, none lost at the page edge");
    assert.equal(new Set(rows.slice(1)).size, 230, "none repeated");
  });

  it("only exports your own data, and needs a login", async () => {
    const other = await ctx.signUp("someone-else@example.com");
    assert.deepEqual(lines((await raw(other, "/api/v1/export/transactions.csv")).text), [HEADER]);
    const anon = await ctx.app.request("/api/v1/export/transactions.csv");
    assert.equal(anon.status, 401);
    const wrong = await raw(other, `/api/v1/export/transactions.csv?account=${bca}`);
    assert.deepEqual(lines(wrong.text), [HEADER], "another user's account id leaks nothing");
  });

  it("rejects bad filters with a 400 instead of a file", async () => {
    for (const q of ["from=2026-02-31", "account=nope", "kind=weird", "to=yesterday"]) {
      const r = await raw(c, `/api/v1/export/transactions.csv?${q}`);
      assert.equal(r.status, 400, q);
      assert.ok(r.headers.get("content-type")?.includes("application/json"), q);
    }
  });
});
