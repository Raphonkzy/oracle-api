import {
  anchorDay,
  averageDaily,
  buildInsights,
  cycleRange,
  daySeries,
  projectSpending,
  shiftMonth,
  type StatsDetails,
  type StatsTrend,
  changePct,
  cycleMonth,
  type LanguageCode,
  flowBuckets,
  periodRange,
  previousRange,
  type InsightsResponse,
  type Period,
  type StatsCategories,
  type StatsFlow,
} from "@oracle/core";
import type { Db } from "@oracle/db/client";
import { sql } from "drizzle-orm";
import { getBudgets } from "./budgets";
import { getCycleStart } from "./settings";
import { getBiggestExpenses, getSpendingByCategory } from "./transactions";

const STALE_DAYS = 14;

async function spendingBetween(db: Db, userId: string, from: string, to: string) {
  const [row] = (await db.execute(sql`
    select coalesce(-sum(amount), 0) as total from transactions
    where user_id = ${userId} and kind = 'expense' and date between ${from}::date and ${to}::date`)) as unknown as { total: string }[];
  return Number(row.total);
}

export async function getStatsFlow(db: Db, userId: string, period: Period, realToday: string, date?: string): Promise<StatsFlow> {
  const start = await getCycleStart(db, userId);
  const today = anchorDay(period, realToday, start, date);
  const range = periodRange(period, today, start);
  const days = (await db.execute(sql`
    select date::text as day, (-sum(amount))::bigint as amount from transactions
    where user_id = ${userId} and kind = 'expense' and date between ${range.from}::date and ${range.to}::date
    group by date`)) as unknown as { day: string; amount: string }[];
  const buckets = flowBuckets(period, today, start).map((b) => ({
    ...b,
    amount: days.filter((d) => d.day >= b.from && d.day <= b.to).reduce((s, d) => s + Number(d.amount), 0),
  }));
  const total = buckets.reduce((s, b) => s + b.amount, 0);
  const prev = previousRange(period, today, start, today !== realToday);
  const previousTotal = await spendingBetween(db, userId, prev.from, prev.to);
  return { period, range, total, previousTotal, changePct: changePct(total, previousTotal), buckets };
}

export async function getStatsCategories(db: Db, userId: string, period: Period, realToday: string, date?: string): Promise<StatsCategories> {
  const start = await getCycleStart(db, userId);
  const today = anchorDay(period, realToday, start, date);
  const range = periodRange(period, today, start);
  const prev = previousRange(period, today, start, today !== realToday);
  const [current, previous] = await Promise.all([
    getSpendingByCategory(db, userId, range.from, range.to),
    getSpendingByCategory(db, userId, prev.from, prev.to),
  ]);
  const key = (c: { categoryId: string | null; name: string }) => c.categoryId ?? `name:${c.name}`;
  const before = new Map(previous.map((c) => [key(c), c.amount]));
  const items = current.map((c) => {
    const previousAmount = before.get(key(c)) ?? 0;
    return { ...c, previousAmount, changePct: changePct(c.amount, previousAmount) };
  });
  return { period, range, total: items.reduce((s, c) => s + c.amount, 0), items };
}

export async function getInsights(db: Db, userId: string, period: Period, realToday: string, language: LanguageCode = "en", date?: string): Promise<InsightsResponse> {
  const start = await getCycleStart(db, userId);
  const today = anchorDay(period, realToday, start, date);
  const range = periodRange(period, today, start);
  const [stats, budgets] = await Promise.all([getStatsCategories(db, userId, period, realToday, date), getBudgets(db, userId, cycleMonth(today, start))]);
  const [counts] = (await db.execute(sql`
    select count(*) filter (where kind = 'expense') as expenses,
           count(*) filter (where kind = 'expense' and transfer_id is not null) as fee_count,
           coalesce(-sum(amount) filter (where kind = 'expense' and transfer_id is not null), 0) as fee_total
    from transactions
    where user_id = ${userId} and date between ${range.from}::date and ${range.to}::date`)) as unknown as { expenses: string; fee_count: string; fee_total: string }[];
  const [big] = (await db.execute(sql`
    select (-t.amount) as amount, t.description, c.name as "categoryName"
    from transactions t left join categories c on c.id = t.category_id
    where t.user_id = ${userId} and t.kind = 'expense' and t.transfer_id is null
      and t.date between ${range.from}::date and ${range.to}::date
    order by t.amount asc, t.created_at desc limit 1`)) as unknown as { amount: string; description: string | null; categoryName: string | null }[];
  // Cash has no app to compare with, so only accounts that mirror a real bank or wallet app can go stale.
  const stale = (await db.execute(sql`
    select a.name, (${realToday}::date - coalesce(max(b.date), a.initial_balance_date))::int as days
    from money_accounts a left join balance_checks b on b.account_id = a.id
    where a.user_id = ${userId} and a.archived_at is null and a.type <> 'cash'
    group by a.id
    having (${realToday}::date - coalesce(max(b.date), a.initial_balance_date)) >= ${STALE_DAYS}
    order by days desc, a.name asc limit 3`)) as unknown as { name: string; days: number }[];
  const items = buildInsights({
    period,
    expenseCount: Number(counts.expenses),
    categories: stats.items,
    budgets: budgets.items,
    biggest: big ? { amount: Number(big.amount), description: big.description, categoryName: big.categoryName } : null,
    staleAccounts: stale.map((s) => ({ name: s.name, days: Number(s.days) })),
    fees: { amount: Number(counts.fee_total), count: Number(counts.fee_count) },
  }, language);
  return { period, items };
}

/** Income and expense per day between two dates. Transfers are left out because they only move money; transfer fees are expense. */
async function dailyFlow(db: Db, userId: string, from: string, to: string) {
  const rows = (await db.execute(sql`
    select date::text as date,
           coalesce(sum(case when kind = 'income' then amount end), 0)::bigint as income,
           coalesce(-sum(case when kind = 'expense' then amount end), 0)::bigint as expense,
           count(*)::int as n
    from transactions
    where user_id = ${userId} and kind in ('income', 'expense') and date between ${from}::date and ${to}::date
    group by date`)) as unknown as { date: string; income: string; expense: string; n: number }[];
  return rows.map((r) => ({ date: r.date, income: Number(r.income), expense: Number(r.expense), n: r.n }));
}

/** The last `months` pay cycles, oldest first, ending with the one that holds `date`. One query for all of them. */
export async function getStatsTrend(db: Db, userId: string, months: number, realToday: string, date?: string): Promise<StatsTrend> {
  const start = await getCycleStart(db, userId);
  const last = cycleMonth(anchorDay("month", realToday, start, date), start);
  const list = Array.from({ length: months }, (_, i) => shiftMonth(last, i - (months - 1)));
  const ranges = list.map((m) => ({ month: m, ...cycleRange(m, start) }));
  const rows = await dailyFlow(db, userId, ranges[0].from, ranges[ranges.length - 1].to);
  return {
    months: ranges.map((r) => {
      const inside = rows.filter((d) => d.date >= r.from && d.date <= r.to);
      const income = inside.reduce((s, d) => s + d.income, 0);
      const expense = inside.reduce((s, d) => s + d.expense, 0);
      return { month: r.month, from: r.from, to: r.to, income, expense, net: income - expense };
    }),
  };
}

/** The numbers behind the charts of one period: every day, the totals, the pace, where it is heading and the biggest expenses. */
export async function getStatsDetails(db: Db, userId: string, period: Period, realToday: string, date?: string): Promise<StatsDetails> {
  const start = await getCycleStart(db, userId);
  const today = anchorDay(period, realToday, start, date);
  const range = periodRange(period, today, start);
  const [rows, biggest] = await Promise.all([dailyFlow(db, userId, range.from, range.to), getBiggestExpenses(db, userId, range.from, range.to, 5)]);
  const days = daySeries(range, rows);
  const income = rows.reduce((s, d) => s + d.income, 0);
  const expense = rows.reduce((s, d) => s + d.expense, 0);
  return {
    period,
    range,
    isCurrent: range.from <= realToday && realToday <= range.to,
    days,
    totals: { income, expense, net: income - expense, count: rows.reduce((s, d) => s + d.n, 0) },
    avgDailyExpense: averageDaily(expense, range, realToday),
    projection: projectSpending(expense, period, range, realToday),
    biggest,
  };
}

