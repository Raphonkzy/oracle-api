import { addDays, type Suggestion } from "@oracle/core";
import type { Db } from "@oracle/db/client";
import { sql } from "drizzle-orm";

/** How far back a habit still counts, and how many suggestions are shown. */
const LOOKBACK_DAYS = 120;
const LIMIT = 8;
/** Entries recorded within this many hours of the current time of day weigh extra: morning coffee in the morning. */
const NEAR_HOURS = 2;

/** The hour of day in Jakarta, 0 to 23. */
export function jakartaHour(now: Date): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", hour: "2-digit", hourCycle: "h23" }).format(now));
}

/**
 * Things you record again and again, so the Add screen can offer them in one tap. Entries that look the same
 * (same description, category and account) form one habit. A habit needs at least 2 uses in the last 120 days.
 * The amount shown is the one used most often. Habits that usually happen around this time of day come first.
 * Transfers, transfer fees and balance adjustments are never suggested, and neither are archived accounts or categories.
 */
export async function getSuggestions(db: Db, userId: string, kind: "income" | "expense", today: string, now: Date): Promise<Suggestion[]> {
  const since = addDays(today, -LOOKBACK_DAYS);
  const hour = jakartaHour(now);
  const rows = (await db.execute(sql`
    with habits as (
      select
        mode() within group (order by nullif(btrim(t.description), '')) as description,
        t.category_id as "categoryId", c.name as "categoryName", c.icon as "categoryIcon",
        t.account_id as "accountId", a.name as "accountName",
        mode() within group (order by abs(t.amount)) as amount,
        count(*) as uses,
        max(t.date)::text as "lastDate",
        count(*) filter (where
          least(
            abs(extract(hour from t.created_at at time zone 'Asia/Jakarta') - ${hour}),
            24 - abs(extract(hour from t.created_at at time zone 'Asia/Jakarta') - ${hour})
          ) <= ${NEAR_HOURS}) as near
      from transactions t
      join money_accounts a on a.id = t.account_id and a.archived_at is null
      left join categories c on c.id = t.category_id
      where t.user_id = ${userId} and t.kind = ${kind} and t.transfer_id is null
        and t.date >= ${since}::date and t.date <= ${today}::date
        and (c.id is null or c.archived_at is null)
      group by lower(btrim(coalesce(t.description, ''))), t.category_id, c.name, c.icon, t.account_id, a.name
      having count(*) >= 2
    )
    select * from habits
    order by (uses + 2 * near) desc, uses desc, "lastDate" desc, coalesce(description, "categoryName", '') asc
    limit ${LIMIT}`)) as unknown as {
    description: string | null;
    categoryId: string | null;
    categoryName: string | null;
    categoryIcon: string | null;
    accountId: string;
    accountName: string;
    amount: string;
    uses: string;
    lastDate: string;
  }[];
  return rows.map((r) => ({
    kind,
    description: r.description,
    categoryId: r.categoryId,
    categoryName: r.categoryName,
    categoryIcon: r.categoryIcon,
    accountId: r.accountId,
    accountName: r.accountName,
    amount: Number(r.amount),
    uses: Number(r.uses),
    lastDate: r.lastDate,
  }));
}
