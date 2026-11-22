/**
 * Creates (or signs in to) a developer account on a running API and fills it with two years of money, for trying the app.
 *
 *   SEED_API_URL=https://money-tracker.example.com SEED_EMAIL=dev@example.com SEED_NAME=Developer SEED_PASSWORD=... \
 *     node --import tsx src/cli/seed-dev-account.ts
 *
 * It talks to the public API like the app does, so every rule applies. The password comes from the environment, never from the
 * command line or a file. An account that already has transactions is left alone, so running it twice never doubles the data.
 */
import { todayISO } from "@oracle/core";
import { runDevData, type Call } from "./dev-data";

const need = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name}.`);
  return v;
};
const api = need("SEED_API_URL").replace(/\/$/, "");
const email = need("SEED_EMAIL");
const name = process.env.SEED_NAME ?? "Developer";
const password = need("SEED_PASSWORD");

let cookie = "";
const raw = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${api}${path}`, { method, headers: { origin: api, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const set = res.headers.getSetCookie().map((c) => c.split(";")[0]);
  if (set.length) cookie = set.join("; ");
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const call: Call = (method, path, body) => raw(method, path, body ?? (method === "GET" || method === "DELETE" ? undefined : {}));

let signedIn = await raw("POST", "/api/auth/sign-in/email", { email, password });
if (signedIn.status !== 200) {
  signedIn = await raw("POST", "/api/auth/sign-up/email", { name, email, password });
  if (signedIn.status !== 200) throw new Error(`Could not sign in or sign up: ${signedIn.status} ${JSON.stringify(signedIn.body)}`);
  console.log(`Created the account ${email}.`);
} else console.log(`Signed in as ${email}.`);

const existing = await call("GET", "/api/v1/transactions?limit=1");
if (existing.body?.items?.length) {
  console.log("This account already has transactions. Nothing was added.");
  process.exit(0);
}
const started = Date.now();
const result = await runDevData(call, todayISO(), (done, total) => process.stdout.write(`\r${done}/${total}`));
console.log(`\nDone in ${Math.round((Date.now() - started) / 1000)}s: ${result.accounts} accounts, ${result.transactions} transactions, ${result.transfers} transfers.`);
