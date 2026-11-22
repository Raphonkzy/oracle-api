import { sql } from "drizzle-orm";
import type { Db } from "../client";
import { providers } from "../schema";
import { PROVIDERS } from "./providers";

/** Inserts or updates the built-in provider catalog. Safe to run repeatedly. */
export async function seedProviders(db: Db) {
  const rows = PROVIDERS.map((p, i) => ({
    id: p.id,
    name: p.name,
    type: p.type,
    group: p.group,
    aliases: p.aliases ?? [],
    color: p.color,
    sortOrder: i,
  }));

  await db
    .insert(providers)
    .values(rows)
    .onConflictDoUpdate({
      target: providers.id,
      set: {
        name: sql`excluded.name`,
        type: sql`excluded.type`,
        group: sql`excluded.group`,
        aliases: sql`excluded.aliases`,
        color: sql`excluded.color`,
        sortOrder: sql`excluded.sort_order`,
      },
    });

  return rows.length;
}
