import { MAX_CATEGORIES, isFeeCategory, type Category, type CategoryKind, type Provider } from "@oracle/core";
import type { Db } from "@oracle/db/client";
import { budgets, categories, providers } from "@oracle/db/schema";
import { and, asc, count, eq, isNull, max } from "drizzle-orm";
import { badRequest, notFound } from "../errors";

export async function listProviders(db: Db): Promise<Provider[]> {
  return db
    .select({ id: providers.id, name: providers.name, type: providers.type, group: providers.group, aliases: providers.aliases })
    .from(providers)
    .orderBy(asc(providers.sortOrder));
}

export async function listCategories(db: Db, userId: string): Promise<Category[]> {
  return db
    .select({ id: categories.id, name: categories.name, kind: categories.kind, icon: categories.icon, color: categories.color })
    .from(categories)
    .where(and(eq(categories.userId, userId), isNull(categories.archivedAt)))
    .orderBy(asc(categories.kind), asc(categories.sortOrder));
}

/** Renames a category and/or changes its icon. The fee category keeps its name because transfers look it up by name. */
export async function updateCategory(db: Db, userId: string, id: string, patch: { name?: string; icon?: string }): Promise<Category> {
  const [row] = await db
    .select({ name: categories.name, kind: categories.kind })
    .from(categories)
    .where(and(eq(categories.userId, userId), eq(categories.id, id), isNull(categories.archivedAt)));
  if (!row) throw notFound("Category not found.");
  if (patch.name !== undefined && row.kind === "expense" && isFeeCategory(row.name) && patch.name !== row.name) {
    throw badRequest(`"${row.name}" is used for transfer fees and cannot be renamed.`, "category_locked");
  }
  if (patch.name !== undefined) {
    const [clash] = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.userId, userId), eq(categories.kind, row.kind), eq(categories.name, patch.name), isNull(categories.archivedAt)));
    if (clash && clash.id !== id) throw badRequest("You already have a category with that name.", "duplicate_category");
  }
  await db
    .update(categories)
    .set({ ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.icon !== undefined ? { icon: patch.icon } : {}) })
    .where(and(eq(categories.userId, userId), eq(categories.id, id)));
  const updated = (await listCategories(db, userId)).find((c) => c.id === id);
  if (!updated) throw notFound("Category not found.");
  return updated;
}

/** Colors for categories people add, handed out in turn. */
const PALETTE = ["#F97316", "#0EA5E9", "#EC4899", "#EAB308", "#6366F1", "#A855F7", "#14B8A6", "#84CC16", "#F43F5E", "#10B981"];

/** Adds a category of the person's own. Names are unique per kind among the active ones. */
export async function createCategory(db: Db, userId: string, input: { name: string; kind: CategoryKind; icon: string }): Promise<Category> {
  const id = await db.transaction(async (tx) => {
    const [{ total }] = await tx.select({ total: count() }).from(categories).where(and(eq(categories.userId, userId), isNull(categories.archivedAt)));
    if (total >= MAX_CATEGORIES) throw badRequest(`You can have at most ${MAX_CATEGORIES} categories.`, "too_many_categories");
    const [clash] = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.userId, userId), eq(categories.kind, input.kind), eq(categories.name, input.name), isNull(categories.archivedAt)));
    if (clash) throw badRequest("You already have a category with that name.", "duplicate_category");
    const [{ top }] = await tx.select({ top: max(categories.sortOrder) }).from(categories).where(and(eq(categories.userId, userId), eq(categories.kind, input.kind)));
    const [row] = await tx
      .insert(categories)
      .values({ userId, name: input.name, kind: input.kind, icon: input.icon, color: PALETTE[total % PALETTE.length], sortOrder: (top ?? -1) + 1 })
      .returning({ id: categories.id });
    return row.id;
  });
  const created = (await listCategories(db, userId)).find((c) => c.id === id);
  if (!created) throw notFound("Category not found.");
  return created;
}

/**
 * Hides a category from the pickers. Transactions that used it keep it, so history and exports still read the same.
 * Its budgets are removed, because a limit on something you can no longer pick would only confuse.
 */
export async function archiveCategory(db: Db, userId: string, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ name: categories.name, kind: categories.kind })
      .from(categories)
      .where(and(eq(categories.userId, userId), eq(categories.id, id), isNull(categories.archivedAt)));
    if (!row) throw notFound("Category not found.");
    if (row.kind === "expense" && isFeeCategory(row.name)) {
      throw badRequest(`"${row.name}" is used for transfer fees and cannot be removed.`, "category_locked");
    }
    await tx.update(categories).set({ archivedAt: new Date() }).where(and(eq(categories.userId, userId), eq(categories.id, id)));
    await tx.delete(budgets).where(and(eq(budgets.userId, userId), eq(budgets.categoryId, id)));
  });
}
