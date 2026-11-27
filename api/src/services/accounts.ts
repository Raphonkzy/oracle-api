import type { Account, AccountInput } from "@oracle/core";
import type { Db } from "@oracle/db/client";
import { moneyAccounts, providers, transactions } from "@oracle/db/schema";
import { and, asc, eq, inArray, isNotNull, isNull, max } from "drizzle-orm";
import { badRequest, notFound } from "../errors";
import { balanceSql, guardOverdraft } from "./balance";
import type { Tx } from "./types";

const balance = balanceSql;

const columns = {
  id: moneyAccounts.id,
  name: moneyAccounts.name,
  type: moneyAccounts.type,
  providerId: moneyAccounts.providerId,
  includeInTotal: moneyAccounts.includeInTotal,
  initialBalance: moneyAccounts.initialBalance,
  initialBalanceDate: moneyAccounts.initialBalanceDate,
  sortOrder: moneyAccounts.sortOrder,
  archivedAt: moneyAccounts.archivedAt,
  balance,
};

const toAccount = (r: Omit<Account, "archivedAt"> & { archivedAt: Date | null }): Account => ({
  ...r,
  archivedAt: r.archivedAt ? r.archivedAt.toISOString() : null,
});

function selectAccounts(db: Db, where: ReturnType<typeof and>) {
  return db
    .select(columns)
    .from(moneyAccounts)
    .leftJoin(transactions, eq(transactions.accountId, moneyAccounts.id))
    .where(where)
    .groupBy(moneyAccounts.id)
    .orderBy(asc(moneyAccounts.sortOrder), asc(moneyAccounts.createdAt));
}

export async function listAccounts(db: Db, userId: string, opts: { archived: boolean }): Promise<Account[]> {
  const state = opts.archived ? isNotNull(moneyAccounts.archivedAt) : isNull(moneyAccounts.archivedAt);
  return (await selectAccounts(db, and(eq(moneyAccounts.userId, userId), state))).map(toAccount);
}

/** One account, active or archived. Throws 404 when it is not the user's. */
export async function getAccount(db: Db, userId: string, id: string): Promise<Account> {
  const [row] = await selectAccounts(db, and(eq(moneyAccounts.userId, userId), eq(moneyAccounts.id, id)));
  if (!row) throw notFound("Account not found.");
  return toAccount(row);
}

export async function getAccounts(db: Db, userId: string, ids: string[]): Promise<Account[]> {
  const rows = await selectAccounts(db, and(eq(moneyAccounts.userId, userId), inArray(moneyAccounts.id, ids)));
  return rows.map(toAccount);
}

/** Throws unless every id is an active account of this user. */
export async function assertActiveAccounts(tx: Tx, userId: string, ids: string[]) {
  const unique = [...new Set(ids)];
  const rows = await tx
    .select({ id: moneyAccounts.id })
    .from(moneyAccounts)
    .where(and(eq(moneyAccounts.userId, userId), inArray(moneyAccounts.id, unique), isNull(moneyAccounts.archivedAt)));
  if (rows.length !== unique.length) throw badRequest("Account not found or already archived.", "account_unavailable");
}

async function assertProviders(tx: Tx, ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((i): i is string => Boolean(i)))];
  if (!wanted.length) return;
  const found = await tx.select({ id: providers.id }).from(providers).where(inArray(providers.id, wanted));
  if (found.length !== wanted.length) throw badRequest("Unknown provider.", "unknown_provider");
}

/** Creates accounts at the end of the user's list. Used by onboarding (many) and "add account" (one). */
export async function createAccounts(db: Db, userId: string, inputs: AccountInput[]): Promise<Account[]> {
  const ids = await db.transaction(async (tx) => {
    await assertProviders(tx, inputs.map((i) => i.providerId));
    const [{ top }] = await tx.select({ top: max(moneyAccounts.sortOrder) }).from(moneyAccounts).where(eq(moneyAccounts.userId, userId));
    const start = (top ?? -1) + 1;
    const rows = await tx
      .insert(moneyAccounts)
      .values(inputs.map((a, i) => ({ ...a, userId, sortOrder: start + i })))
      .returning({ id: moneyAccounts.id });
    return rows.map((r) => r.id);
  });
  const created = await getAccounts(db, userId, ids);
  return ids.map((id) => created.find((a) => a.id === id)!);
}

export async function updateAccount(
  db: Db,
  userId: string,
  id: string,
  patch: Partial<Pick<AccountInput, "name" | "type" | "initialBalance" | "includeInTotal">>,
): Promise<Account> {
  // Ownership first: a foreign or missing id throws 404 here, before any row lock is taken on it.
  await getAccount(db, userId, id);
  // A lower opening balance or a type change can also push the account below zero, so it passes the same check.
  const updated = await db.transaction((tx) =>
    guardOverdraft(tx, [id], () =>
      tx
        .update(moneyAccounts)
        .set(patch)
        .where(and(eq(moneyAccounts.userId, userId), eq(moneyAccounts.id, id)))
        .returning({ id: moneyAccounts.id }),
    ),
  );
  if (!updated.length) throw notFound("Account not found.");
  return getAccount(db, userId, id);
}

export async function setArchived(db: Db, userId: string, id: string, archived: boolean): Promise<Account> {
  const updated = await db
    .update(moneyAccounts)
    .set({ archivedAt: archived ? new Date() : null })
    .where(and(eq(moneyAccounts.userId, userId), eq(moneyAccounts.id, id)))
    .returning({ id: moneyAccounts.id });
  if (!updated.length) throw notFound("Account not found.");
  return getAccount(db, userId, id);
}

/** Sets the order of all active accounts. `ids` must list every active account exactly once. */
export async function reorderAccounts(db: Db, userId: string, ids: string[]): Promise<Account[]> {
  await db.transaction(async (tx) => {
    const active = await tx
      .select({ id: moneyAccounts.id })
      .from(moneyAccounts)
      .where(and(eq(moneyAccounts.userId, userId), isNull(moneyAccounts.archivedAt)))
      .for("update");
    const same = new Set(ids).size === ids.length && ids.length === active.length && active.every((a) => ids.includes(a.id));
    if (!same) throw badRequest("The order must list every active account exactly once.", "invalid_order");
    for (const [order, id] of ids.entries()) {
      await tx.update(moneyAccounts).set({ sortOrder: order }).where(eq(moneyAccounts.id, id));
    }
  });
  return listAccounts(db, userId, { archived: false });
}
