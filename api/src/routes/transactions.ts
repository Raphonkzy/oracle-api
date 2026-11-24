import { transactionInput, transactionPatchInput, transactionsQuery, transferInput, transferPatchInput } from "@oracle/core";
import type { Db } from "@oracle/db/client";
import { Hono } from "hono";
import { paramId, parseBody, parseQuery, type AppEnv } from "../http";
import { createTransaction, createTransfer, deleteTransaction, deleteTransfer, getTransaction, listTransactions, updateTransaction, updateTransfer } from "../services/transactions";

export function transactionRoutes(db: Db) {
  const r = new Hono<AppEnv>();

  r.get("/", async (c) => c.json(await listTransactions(db, c.get("userId"), parseQuery(c, transactionsQuery))));

  r.post("/", async (c) => {
    const input = await parseBody(c, transactionInput);
    return c.json({ transaction: await createTransaction(db, c.get("userId"), input) }, 201);
  });

  r.get("/:id", async (c) => c.json({ transaction: await getTransaction(db, c.get("userId"), paramId(c)) }));

  r.patch("/:id", async (c) => {
    const id = paramId(c);
    const patch = await parseBody(c, transactionPatchInput);
    return c.json({ transaction: await updateTransaction(db, c.get("userId"), id, patch) });
  });

  r.delete("/:id", async (c) => {
    await deleteTransaction(db, c.get("userId"), paramId(c));
    return c.body(null, 204);
  });

  return r;
}

export function transferRoutes(db: Db) {
  const r = new Hono<AppEnv>();
  r.post("/", async (c) => {
    const input = await parseBody(c, transferInput);
    return c.json({ rows: await createTransfer(db, c.get("userId"), input) }, 201);
  });

  r.patch("/:id", async (c) => {
    const id = paramId(c);
    const patch = await parseBody(c, transferPatchInput);
    return c.json({ rows: await updateTransfer(db, c.get("userId"), id, patch) });
  });

  r.delete("/:id", async (c) => {
    await deleteTransfer(db, c.get("userId"), paramId(c));
    return c.body(null, 204);
  });
  return r;
}
