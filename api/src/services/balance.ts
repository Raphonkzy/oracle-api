import { formatRupiah, isDebtType, type AccountType } from "@oracle/core";
import { moneyAccounts, transactions } from "@oracle/db/schema";
import { sql } from "drizzle-orm";
import { HttpError } from "../errors";
import type { Tx } from "./types";

/**
 * The one definition of an account balance: the opening balance plus everything booked on that account.
 * Every screen, the total, the AI and the overdraft check read it from here.
 * Use it inside a query that left-joins `transactions` on the account and groups by the account.
 */
export const balanceSql = sql<number>`(${moneyAccounts.initialBalance} + coalesce(sum(${transactions.amount}), 0))::bigint`.mapWith(Number);

type Snapshot = Map<string, { name: string; type: AccountType; balance: number }>;

/** Current balances of the given accounts, read inside the caller's transaction. */
export async function snapshot(tx: Tx, ids: string[]): Promise<Snapshot> {
  if (!ids.length) return new Map();
  const rows = (await tx.execute(sql`
    select a.id, a.name, a.type, (a.initial_balance + coalesce(sum(t.amount), 0))::bigint as balance
    from money_accounts a left join transactions t on t.account_id = a.id
    where a.id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
    group by a.id`)) as unknown as { id: string; name: string; type: AccountType; balance: string }[];
  return new Map(rows.map((r) => [r.id, { name: r.name, type: r.type, balance: Number(r.balance) }]));
}

/**
 * Runs a change to the ledger and rejects it when it would take an account below zero.
 *
 * - Each account stands alone. Money is never borrowed from another account.
 * - Paylater and credit cards are debts, so they are allowed to go negative.
 * - An account that was already below zero before the change (older data) may stay there, but may not go lower.
 * - The accounts are locked first, so two requests cannot both spend the same money.
 *
 * Throws `insufficient_balance`; the surrounding database transaction then rolls the change back.
 */
export async function guardOverdraft<T>(tx: Tx, accountIds: string[], change: () => Promise<T>): Promise<T> {
  const ids = [...new Set(accountIds)].sort();
  if (ids.length) await tx.execute(sql`select 1 from money_accounts where id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}) order by id for update`);
  const before = await snapshot(tx, ids);
  const result = await change();
  const after = await snapshot(tx, ids);
  for (const [id, now] of after) {
    if (isDebtType(now.type)) continue;
    const was = before.get(id)?.balance ?? 0;
    if (now.balance < 0 && now.balance < was) {
      throw new HttpError(
        400,
        "insufficient_balance",
        `Not enough balance in ${now.name}. Its balance is ${formatRupiah(was)} and this would leave it at ${formatRupiah(now.balance)}. Money from other accounts is never used.`,
        { account: now.name, balance: was, after: now.balance },
      );
    }
  }
  return result;
}
