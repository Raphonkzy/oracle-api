import { firstError } from "@oracle/core";
import type { Context } from "hono";
import type { z } from "zod";
import { HttpError, notFound } from "./errors";

export type SessionUser = { id: string; name: string; email: string; createdAt: Date };
export type AppEnv = { Variables: { userId: string; user: SessionUser } };

/** Reads and validates a JSON body. Throws a 400 with the first problem in plain English. */
export async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, "invalid_json", "The request body is not valid JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, "validation", firstError(parsed.error));
  return parsed.data;
}

/** Validates query-string parameters. Empty values count as absent. */
export function parseQuery<S extends z.ZodType>(c: Context, schema: S): z.output<S> {
  const raw = Object.fromEntries(Object.entries(c.req.query()).filter(([, v]) => v !== ""));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, "validation", firstError(parsed.error));
  return parsed.data;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A path id. Anything that is not a UUID cannot exist, so it is a plain 404. */
export function paramId(c: Context, name = "id"): string {
  const value = c.req.param(name);
  if (!value || !UUID.test(value)) throw notFound();
  return value;
}
