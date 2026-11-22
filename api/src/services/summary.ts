import { anchorDay, periodRange, summarize, type Period, type Summary } from "@oracle/core";
import type { Db } from "@oracle/db/client";
import { listAccounts } from "./accounts";
import { getCycleStart } from "./settings";
import { getFlow, getSpendingByCategory, listTransactions } from "./transactions";

/** Everything the home screen needs in one call. `today` is a YYYY-MM-DD in Jakarta time. */
export async function getSummary(db: Db, userId: string, period: Period, today: string, date?: string): Promise<Summary> {
  const start = await getCycleStart(db, userId);
  // `date` may point at an earlier period. Balances are always as of now; the flow and the spending are for that period.
  const range = periodRange(period, anchorDay(period, today, start, date), start);
  const [accounts, flow, spendingByCategory, recent] = await Promise.all([
    listAccounts(db, userId, { archived: false }),
    getFlow(db, userId, range.from, range.to),
    getSpendingByCategory(db, userId, range.from, range.to),
    listTransactions(db, userId, { limit: 5 }),
  ]);
  const s = summarize(accounts);
  return {
    period,
    range,
    total: s.total,
    assets: s.assets,
    debts: s.debts,
    countedCount: s.countedCount,
    allCount: s.allCount,
    ring: s.segments,
    byType: s.byType,
    flow,
    spendingByCategory,
    accounts,
    recent: recent.items,
  };
}
