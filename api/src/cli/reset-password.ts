/**
 * Sets a new password for one account, from the server. For the owner who forgot the password and has no email set up.
 *   sh reset-password.sh you@example.com
 * The new password is read from the first line of standard input, so it never appears in a command line or shell history.
 */
import { createDb } from "@oracle/db/client";
import { createAuth } from "../auth";
import { loadConfig } from "../config";

const MIN_LENGTH = 10;

async function readLine(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
    if (Buffer.concat(chunks).includes(10)) break;
  }
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0];
}

/** Returns an error message, or null when the password was changed. Kept apart from the process handling so a test can call it. */
export async function resetPassword(auth: ReturnType<typeof createAuth>, email: string, password: string): Promise<string | null> {
  if (password.length < MIN_LENGTH) return `The password must be at least ${MIN_LENGTH} characters.`;
  const ctx = await auth.$context;
  const found = await ctx.internalAdapter.findUserByEmail(email.trim().toLowerCase(), { includeAccounts: true });
  if (!found) return `There is no account with the email ${email}.`;
  const hash = await ctx.password.hash(password);
  const credential = found.accounts.find((a) => a.providerId === "credential");
  if (credential) await ctx.internalAdapter.updatePassword(found.user.id, hash);
  else await ctx.internalAdapter.linkAccount({ userId: found.user.id, providerId: "credential", accountId: found.user.id, password: hash });
  // Every phone that was signed in has to sign in again with the new password.
  const sessions = await ctx.internalAdapter.listSessions(found.user.id);
  if (sessions.length) await ctx.internalAdapter.deleteSessions(sessions.map((s) => s.token));
  return null;
}

if (process.argv[1] && /reset-password\.ts$/.test(process.argv[1].replace(/\\/g, "/"))) {
  const email = process.argv[2];
  if (!email) {
    console.error("Usage: sh reset-password.sh you@example.com");
    process.exit(2);
  }
  const config = loadConfig();
  const { db, client } = createDb(config.databaseUrl);
  const auth = createAuth({ db, secret: config.secret, baseURL: config.apiUrl, signupMode: config.signupMode, rateLimit: false });
  const password = await readLine();
  const problem = await resetPassword(auth, email, password);
  await client.end({ timeout: 5 });
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  console.log(`Done. The password of ${email} was changed and every signed-in phone was signed out.`);
}
