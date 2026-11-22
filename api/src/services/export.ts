import { kindLabel, toCsv, type LedgerRow } from "@oracle/core";
import type { Db } from "@oracle/db/client";
import { listTransactions } from "./transactions";

type Filters = { q?: string; account?: string; kind?: "income" | "expense" | "transfer" | "adjustment"; from?: string; to?: string };

export const CSV_HEADER = ["Date", "Account", "Type", "Category", "Description", "Note", "Counterpart account", "Amount (IDR)"];

/** Every transaction that matches the filters, oldest first, as CSV text. Amounts are signed whole rupiah. */
export async function exportTransactionsCsv(db: Db, userId: string, filters: Filters): Promise<string> {
  const rows: LedgerRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await listTransactions(db, userId, { ...filters, limit: 200, cursor });
    rows.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  rows.reverse(); // the list is newest first, a spreadsheet reads better the other way round
  return toCsv(
    CSV_HEADER,
    rows.map((r) => [r.date, r.accountName, kindLabel(r), r.categoryName, r.description, r.note, r.counterpartName, r.amount]),
  );
}
