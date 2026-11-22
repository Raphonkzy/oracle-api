import { normalizeCycleDay, type UserSettings } from "@oracle/core";
import type { Db } from "@oracle/db/client";
import { userSettings } from "@oracle/db/schema";
import { eq } from "drizzle-orm";

/** The day of the month this person's "month" starts. 1 (the calendar month) until they choose otherwise. */
export async function getCycleStart(db: Db, userId: string): Promise<number> {
  const [row] = await db.select({ d: userSettings.cycleStartDay }).from(userSettings).where(eq(userSettings.userId, userId));
  return normalizeCycleDay(row?.d);
}

export async function getSettings(db: Db, userId: string): Promise<UserSettings> {
  return { cycleStartDay: await getCycleStart(db, userId) };
}

export async function setSettings(db: Db, userId: string, input: UserSettings): Promise<UserSettings> {
  await db
    .insert(userSettings)
    .values({ userId, cycleStartDay: input.cycleStartDay })
    .onConflictDoUpdate({ target: userSettings.userId, set: { cycleStartDay: input.cycleStartDay, updatedAt: new Date() } });
  return getSettings(db, userId);
}
