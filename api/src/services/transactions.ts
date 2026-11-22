import { FEE_CATEGORY, LEGACY_FEE_CATEGORY, isISODate, monthRange, type LedgerRow, type Page, type TransactionInput, type TransferInput } from "@oracle/core";
import type { Db } from "@oracle/db/client";
import { balanceChecks, categories, transactions, transfers } from "@oracle/db/schema";
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { badRequest, notFound } from "../errors";
import { assertActiveAccounts, getAccount } from "./accounts";
import { guardOverdraft, snapshot } from "./balance";
import type { Tx } from "./types";

/* Reading: one SELECT shared by the transaction list, the account ledger and single lookups. */

const baseSelect = sql`
  select t.id, t.kind, t.amount::bigint as amount, t.date::text as date, t.description, t.note,
         t.category_id as "categoryId", c.name as "categoryName", c.icon as "categoryIcon",
         t.account_id as "accountId", a.name as "accountName", t.transfer_id as "transferId",
         case when t.kind = 'transfer_out' then ta.name when t.kind = 'transfer_in' then fa.name end as "counterpartName",
         (t.transfer_id is not null and t.kind = 'expense') as "isTransferFee",
         t.created_at as created_ts, t.created_at::text as "createdAt"
  from transactions t
  join money_accounts a on a.id = t.account_id
  left join categories c on c.id = t.category_id
  left join transfers tr on tr.id = t.transfer_id
  left join money_accounts fa on fa.id = tr.from_account_id
  left join money_accounts ta on ta.id = tr.to_account_id`;

type RawRow = Record<string, unknown>;

function toRow(r: RawRow): LedgerRow {
  return {
    id: r.id as string,
    kind: r.kind as LedgerRow["kind"],
    amount: Number(r.amount),
    date: r.date as string,
    description: (r.description as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    categoryId: (r.categoryId as string | null) ?? null,
    categoryName: (r.categoryName as string | null) ?? null,
    categoryIcon: (r.categoryIcon as string | null) ?? null,
    accountId: r.accountId as string,
    accountName: r.accountName as string,
    transferId: (r.transferId as string | null) ?? null,
    counterpartName: (r.counterpartName as string | null) ?? null,
    isTransferFee: Boolean(r.isTransferFee),
    runningBalance: r.runningBalance == null ? null : Number(r.runningBalance),
    createdAt: r.createdAt as string,
  };
}

/* Paging: keyset on (date, created_at, id). Stable even when rows are added while someone scrolls. */

const cursorSchema = z.object({
  date: z.string().refine(isISODate),
  createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:?\d{2})?$/),
  id: z.uuid(),
});
type Cursor = z.infer<typeof cursorSchema>;

const encodeCursor = (r: LedgerRow) => Buffer.from(JSON.stringify({ date: r.date, createdAt: r.createdAt, id: r.id } satisfies Cursor)).toString("base64url");

function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    if (parsed.success) return parsed.data;
  } catch {
    // Falls through to the error below.
  }
  throw badRequest("Invalid page cursor.", "invalid_cursor");
}

const page = (rows: LedgerRow[], limit: number): Page<LedgerRow> => {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? encodeCursor(items[items.length - 1]) : null };
};

export type TransactionFilters = {
  q?: string;
  account?: string;
  category?: string;
  kind?: "income" | "expense" | "transfer" | "adjustment";
  from?: string;
  to?: string;
  limit: number;
  cursor?: string;
};

export async function listTransactions(db: Db, userId: string, f: TransactionFilters): Promise<Page<LedgerRow>> {
  const cursor = decodeCursor(f.cursor);
  const conds: SQL[] = [sql`t.user_id = ${userId}`];
  if (f.account) conds.push(sql`t.account_id = ${f.account}`);
  // A category, or "none" for the spending that has no category.
  if (f.category === "none") conds.push(sql`t.category_id is null`);
  else if (f.category) conds.push(sql`t.category_id = ${f.category}::uuid`);
  if (f.kind === "transfer") conds.push(sql`t.kind in ('transfer_in', 'transfer_out')`);
  else if (f.kind) conds.push(sql`t.kind = ${f.kind}`);
  if (f.from) conds.push(sql`t.date >= ${f.from}::date`);
  if (f.to) conds.push(sql`t.date <= ${f.to}::date`);
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    conds.push(sql`(t.description ilike ${like} or t.note ilike ${like} or c.name ilike ${like} or a.name ilike ${like})`);
  }
  if (cursor) conds.push(sql`(t.date, t.created_at, t.id) < (${cursor.date}::date, ${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`);

  const rows = await db.execute(sql`
    ${baseSelect}
    where ${sql.join(conds, sql` and `)}
    order by t.date desc, t.created_at desc, t.id desc
    limit ${f.limit + 1}`);
  return page((rows as unknown as RawRow[]).map(toRow), f.limit);
}

/** Statement for one account, newest first, with the balance after each row. */
export async function getAccountLedger(
  db: Db,
  userId: string,
  accountId: string,
  opts: { month?: string; limit: number; cursor?: string },
): Promise<Page<LedgerRow>> {
  await getAccount(db, userId, accountId);
  const cursor = decodeCursor(opts.cursor);
  const filters: SQL[] = [];
  if (opts.month) {
    const range = monthRange(opts.month);
    filters.push(sql`y.date >= ${range.from}`, sql`y.date <= ${range.to}`);
  }
  if (cursor) filters.push(sql`(y.date, y.created_ts, y.id) < (${cursor.date}, ${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`);
  const where = filters.length ? sql`where ${sql.join(filters, sql` and `)}` : sql``;

  // The running balance is computed over every row first, then the filters are applied.
  const rows = await db.execute(sql`
    select * from (
      select x.*, (a.initial_balance + sum(x.amount) over (order by x.date, x.created_ts, x.id))::bigint as "runningBalance"
      from (${baseSelect} where t.user_id = ${userId} and t.account_id = ${accountId}) x
      join money_accounts a on a.id = x."accountId"
    ) y ${where}
    order by y.date desc, y.created_ts desc, y.id desc
    limit ${opts.limit + 1}`);
  return page((rows as unknown as RawRow[]).map(toRow), opts.limit);
}

export async function getTransaction(db: Db, userId: string, id: string): Promise<LedgerRow> {
  const rows = await db.execute(sql`${baseSelect} where t.user_id = ${userId} and t.id = ${id}`);
  const row = (rows as unknown as RawRow[])[0];
  if (!row) throw notFound("Transaction not found.");
  return toRow(row);
}

/** The biggest expenses in a range (transfer fees included, transfers themselves not). Ties go to the newest. */
export async function getBiggestExpenses(db: Db, userId: string, from: string, to: string, limit: number): Promise<LedgerRow[]> {
  const rows = await db.execute(sql`
    ${baseSelect}
    where t.user_id = ${userId} and t.kind = 'expense' and t.date between ${from}::date and ${to}::date
    order by t.amount asc, t.date desc, t.created_at desc, t.id desc
    limit ${limit}`);
  return (rows as unknown as RawRow[]).map(toRow);
}

/* Reporting numbers for the dashboard. */

/** Income and expense in a date range. Transfers are excluded because they only move money; transfer fees count as expense. */
export async function getFlow(db: Db, userId: string, from: string, to: string) {
  const [row] = (await db.execute(sql`
    select coalesce(sum(case when kind = 'income' then amount end), 0)::bigint as income,
           coalesce(-sum(case when kind = 'expense' then amount end), 0)::bigint as expense
    from transactions where user_id = ${userId} and date between ${from}::date and ${to}::date`)) as unknown as { income: string; expense: string }[];
  return { income: Number(row.income), expense: Number(row.expense) };
}

export async function getSpendingByCategory(db: Db, userId: string, from: string, to: string) {
  const rows = (await db.execute(sql`
    select c.id as "categoryId", coalesce(c.name, 'Uncategorized') as name, (-sum(t.amount))::bigint as amount
    from transactions t left join categories c on c.id = t.category_id
    where t.user_id = ${userId} and t.kind = 'expense' and t.date between ${from}::date and ${to}::date
    group by c.id, c.name
    order by amount desc, name asc`)) as unknown as { categoryId: string | null; name: string; amount: string }[];
  const total = rows.reduce((s, r) => s + Number(r.amount), 0);
  return rows.map((r) => ({ categoryId: r.categoryId, name: r.name, amount: Number(r.amount), share: total ? Number(r.amount) / total : 0 }));
}

/* Writing */

async function assertCategory(tx: Tx, userId: string, categoryId: string | null, kind: "income" | "expense") {
  if (!categoryId) return;
  const [row] = await tx.select({ kind: categories.kind }).from(categories).where(and(eq(categories.userId, userId), eq(categories.id, categoryId)));
  if (!row || row.kind !== kind) throw badRequest("Category does not match the transaction type.", "invalid_category");
}

const signed = (kind: "income" | "expense", amount: number) => (kind === "income" ? amount : -amount);

export async function createTransaction(db: Db, userId: string, d: TransactionInput): Promise<LedgerRow> {
  const id = await db.transaction(async (tx) => {
    await assertActiveAccounts(tx, userId, [d.accountId]);
    await assertCategory(tx, userId, d.categoryId, d.kind);
    return guardOverdraft(tx, [d.accountId], async () => {
      const [row] = await tx
        .insert(transactions)
        .values({ ...d, userId, amount: signed(d.kind, d.amount) })
        .returning({ id: transactions.id });
      return row.id;
    });
  });
  return getTransaction(db, userId, id);
}

export async function updateTransaction(db: Db, userId: string, id: string, patch: Partial<TransactionInput>): Promise<LedgerRow> {
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.id, id)))
      .for("update");
    if (!existing) throw notFound("Transaction not found.");
    if (existing.transferId) throw badRequest("A transfer cannot be edited. Delete it and create the transfer again.", "transfer_locked");
    if (existing.kind !== "income" && existing.kind !== "expense") throw badRequest("A balance adjustment cannot be edited. Delete it and run the balance update again.", "adjustment_locked");

    const merged = {
      kind: patch.kind ?? existing.kind,
      accountId: patch.accountId ?? existing.accountId,
      amount: patch.amount ?? Math.abs(existing.amount),
      date: patch.date ?? existing.date,
      categoryId: patch.categoryId === undefined ? existing.categoryId : patch.categoryId,
      description: patch.description === undefined ? existing.description : patch.description,
      note: patch.note === undefined ? existing.note : patch.note,
    };
    await assertActiveAccounts(tx, userId, [merged.accountId]);
    await assertCategory(tx, userId, merged.categoryId, merged.kind);
    // Moving a transaction to another account changes both balances, so both are checked.
    await guardOverdraft(tx, [existing.accountId, merged.accountId], () =>
      tx
        .update(transactions)
        .set({ ...merged, amount: signed(merged.kind, merged.amount) })
        .where(eq(transactions.id, id)),
    );
  });
  return getTransaction(db, userId, id);
}

/** Deletes a transaction. For a transfer leg or fee, the whole transfer goes with it. */
export async function deleteTransaction(db: Db, userId: string, id: string) {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ transferId: transactions.transferId, accountId: transactions.accountId })
      .from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.id, id)));
    if (!row) throw notFound("Transaction not found.");
    // Removing money that came in (income, or the receiving side of a transfer) can leave an account short.
    const touched = row.transferId
      ? (await tx.select({ accountId: transactions.accountId }).from(transactions).where(eq(transactions.transferId, row.transferId))).map((r) => r.accountId)
      : [row.accountId];
    await guardOverdraft(tx, touched, async () => {
      await tx.update(balanceChecks).set({ adjustmentTransactionId: null }).where(eq(balanceChecks.adjustmentTransactionId, id));
      if (row.transferId) await tx.delete(transfers).where(and(eq(transfers.userId, userId), eq(transfers.id, row.transferId)));
      else await tx.delete(transactions).where(and(eq(transactions.userId, userId), eq(transactions.id, id)));
    });
  });
}

export async function createTransfer(db: Db, userId: string, d: TransferInput): Promise<LedgerRow[]> {
  const transferId = await db.transaction(async (tx) => {
    await assertActiveAccounts(tx, userId, [d.fromAccountId, d.toAccountId]);
    // The source pays the amount and the fee from its own balance.
    return guardOverdraft(tx, [d.fromAccountId, d.toAccountId], () => insertTransfer(tx, userId, d));
  });
  const rows = await db.execute(sql`${baseSelect} where t.user_id = ${userId} and t.transfer_id = ${transferId} order by t.created_at`);
  return (rows as unknown as RawRow[]).map(toRow);
}

/** Books the transfer: money out of the source, money into the target, and an optional fee on the source. Neither side is income or expense. */
async function insertTransfer(tx: Tx, userId: string, d: TransferInput): Promise<string> {
  const [tr] = await tx.insert(transfers).values({ ...d, userId }).returning({ id: transfers.id });
  // The legs share one transaction, so now() would be identical. One microsecond apart keeps their order fixed: out, in, fee.
  const at = (n: number) => sql`now() + ${n}::int * interval '1 microsecond'`;
  const out = { userId, accountId: d.fromAccountId, kind: "transfer_out" as const, amount: -d.amount, date: d.date, note: d.note, transferId: tr.id, createdAt: at(0) };
  const into = { userId, accountId: d.toAccountId, kind: "transfer_in" as const, amount: d.amount, date: d.date, note: d.note, transferId: tr.id, createdAt: at(1) };
  if (d.fee > 0) {
    const [adminCat] = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.userId, userId), eq(categories.kind, "expense"), inArray(categories.name, [FEE_CATEGORY, LEGACY_FEE_CATEGORY]), isNull(categories.archivedAt)))
      // The current name wins if an account somehow has both.
      .orderBy(sql`(${categories.name} = ${FEE_CATEGORY}) desc`)
      .limit(1);
    const fee = {
      userId,
      accountId: d.fromAccountId,
      kind: "expense" as const,
      amount: -d.fee,
      date: d.date,
      description: "Transfer fee",
      categoryId: adminCat?.id ?? null,
      transferId: tr.id,
      createdAt: at(2),
    };
    await tx.insert(transactions).values([out, into, fee]);
  } else {
    await tx.insert(transactions).values([out, into]);
  }
  return tr.id;
}

/** "Balance update": records the real balance and books the difference as an adjustment. */
export async function checkBalance(db: Db, userId: string, accountId: string, input: { actualBalance: number; date: string }) {
  const result = await db.transaction(async (tx) => {
    await assertActiveAccounts(tx, userId, [accountId]);
    // Lock the account so two balance updates cannot both book the same difference.
    await tx.execute(sql`select 1 from money_accounts where id = ${accountId} for update`);
    const current = (await snapshot(tx, [accountId])).get(accountId)?.balance ?? 0;
    const difference = input.actualBalance - current;
    let adjustmentId: string | null = null;
    if (difference !== 0) {
      const [adj] = await tx
        .insert(transactions)
        .values({ userId, accountId, kind: "adjustment", amount: difference, date: input.date, description: "Balance adjustment" })
        .returning({ id: transactions.id });
      adjustmentId = adj.id;
    }
    await tx.insert(balanceChecks).values({
      userId,
      accountId,
      date: input.date,
      actualBalance: input.actualBalance,
      difference,
      adjustmentTransactionId: adjustmentId,
    });
    return { difference, adjustmentId };
  });
  return { ...result, account: await getAccount(db, userId, accountId) };
}
