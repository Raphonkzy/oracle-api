import type { Db } from "@oracle/db/client";

/** The handle Drizzle gives inside `db.transaction(...)`. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
