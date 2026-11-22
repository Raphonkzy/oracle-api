import { accountInput, accountPatchInput, balanceCheckBody, ledgerQuery, onboardingInput, reorderInput } from "@oracle/core";
import type { Db } from "@oracle/db/client";
import { Hono } from "hono";
import { z } from "zod";
import { paramId, parseBody, parseQuery, type AppEnv } from "../http";
import { createAccounts, getAccount, listAccounts, reorderAccounts, setArchived, updateAccount } from "../services/accounts";
import { checkBalance, getAccountLedger } from "../services/transactions";

const listQuery = z.object({ archived: z.enum(["true", "false"]).default("false") });

export function accountRoutes(db: Db) {
  const r = new Hono<AppEnv>();

  r.get("/", async (c) => {
    const { archived } = parseQuery(c, listQuery);
    return c.json({ accounts: await listAccounts(db, c.get("userId"), { archived: archived === "true" }) });
  });

  r.post("/", async (c) => {
    const input = await parseBody(c, accountInput);
    const [account] = await createAccounts(db, c.get("userId"), [input]);
    return c.json({ account }, 201);
  });

  // Onboarding: add several accounts at once.
  r.post("/batch", async (c) => {
    const { accounts } = await parseBody(c, onboardingInput);
    return c.json({ accounts: await createAccounts(db, c.get("userId"), accounts) }, 201);
  });

  r.post("/reorder", async (c) => {
    const { ids } = await parseBody(c, reorderInput);
    return c.json({ accounts: await reorderAccounts(db, c.get("userId"), ids) });
  });

  r.get("/:id", async (c) => c.json({ account: await getAccount(db, c.get("userId"), paramId(c)) }));

  r.patch("/:id", async (c) => {
    const id = paramId(c);
    const patch = await parseBody(c, accountPatchInput);
    return c.json({ account: await updateAccount(db, c.get("userId"), id, patch) });
  });

  r.post("/:id/archive", async (c) => c.json({ account: await setArchived(db, c.get("userId"), paramId(c), true) }));
  r.post("/:id/restore", async (c) => c.json({ account: await setArchived(db, c.get("userId"), paramId(c), false) }));

  r.get("/:id/ledger", async (c) => {
    const id = paramId(c);
    return c.json(await getAccountLedger(db, c.get("userId"), id, parseQuery(c, ledgerQuery)));
  });

  r.post("/:id/balance-checks", async (c) => {
    const id = paramId(c);
    const input = await parseBody(c, balanceCheckBody);
    return c.json(await checkBalance(db, c.get("userId"), id, input), 201);
  });

  return r;
}
