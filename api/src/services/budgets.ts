import type { BudgetItem, BudgetsResponse } from "@oracle/core";
import { cycleRange } from "@oracle/core";
import type { Db } from "@oracle/db/client";
import { budgets, categories } from "@oracle/db/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { badRequest } from "../errors";
import { getCycleStart } from "./settings";

export const previousMonth = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

/** Budgets for one month with what was spent in each category. */
export async function getBudgets(db: Db, userId: string, month: string): Promise<BudgetsResponse> {
  const { from, to } = cycleRange(month, await getCycleStart(db, userId));
  const rows = (await db.execute(sql`
    select c.id as "categoryId", c.name, b.amount as budget,
           coalesce((select -sum(t.amount) from transactions t
                     where t.user_id = ${userId} and t.kind = 'expense' and t.category_id = c.id
                       and t.date between ${from}::date and ${to}::date), 0) as spent
    from budgets b join categories c on c.id = b.category_id
    where b.user_id = ${userId} and b.month = ${month}
    order by c.sort_order asc, c.name asc`)) as unknown as { categoryId: string; name: string; budget: string; spent: string }[];
  const items: BudgetItem[] = rows.map((r) => ({ categoryId: r.categoryId, name: r.name, budget: Number(r.budget), spent: Number(r.spent) }));
  const [other] = (await db.execute(sql`
    select coalesce(-sum(t.amount), 0) as spent from transactions t
    where t.user_id = ${userId} and t.kind = 'expense' and t.date between ${from}::date and ${to}::date
      and (t.category_id is null or t.category_id not in (select category_id from budgets where user_id = ${userId} and month = ${month}))`)) as unknown as { spent: string }[];
  const budget = items.reduce((s, i) => s + i.budget, 0);
  const spent = items.reduce((s, i) => s + i.spent, 0);
  return { month, budget, spent, left: budget - spent, items, unbudgetedSpent: Number(other.spent) };
}

async function assertExpenseCategories(db: Db, userId: string, ids: string[]) {
  if (!ids.length) return;
  const rows = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.userId, userId), eq(categories.kind, "expense"), isNull(categories.archivedAt), inArray(categories.id, ids)));
  if (rows.length !== ids.length) throw badRequest("A budget needs an active expense category of yours.", "invalid_category");
}

/** Replaces every budget of the month with the given list. An empty list clears the month. */
export async function setBudgets(db: Db, userId: string, month: string, items: { categoryId: string; amount: number }[]) {
  await assertExpenseCategories(db, userId, items.map((i) => i.categoryId));
  await db.transaction(async (tx) => {
    await tx.delete(budgets).where(and(eq(budgets.userId, userId), eq(budgets.month, month)));
    if (items.length) await tx.insert(budgets).values(items.map((i) => ({ userId, month, categoryId: i.categoryId, amount: i.amount })));
  });
  return getBudgets(db, userId, month);
}

/** Copies last month's budgets into categories that have none yet. Existing budgets are kept as they are. */
export async function copyPreviousBudgets(db: Db, userId: string, month: string) {
  const prev = previousMonth(month);
  const copied = await db.transaction(async (tx) => {
    const source = await tx
      .select({ categoryId: budgets.categoryId, amount: budgets.amount })
      .from(budgets)
      .innerJoin(categories, eq(categories.id, budgets.categoryId))
      .where(and(eq(budgets.userId, userId), eq(budgets.month, prev), isNull(categories.archivedAt)));
    if (!source.length) return 0;
    const inserted = await tx
      .insert(budgets)
      .values(source.map((s) => ({ userId, month, categoryId: s.categoryId, amount: s.amount })))
      .onConflictDoNothing()
      .returning({ id: budgets.id });
    return inserted.length;
  });
  return { ...(await getBudgets(db, userId, month)), copied };
}
