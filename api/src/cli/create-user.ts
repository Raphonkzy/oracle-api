/**
 * Creates an account from the server, for the owner to give to someone while sign-up is closed.
 *   sh create-user.sh friend@example.com "Friend Name"
 * The password is read from the first line of standard input, so it never appears in a command line or shell history.
 * The account gets the same default categories as any new account. The person signs in from the app and sets up their own accounts.
 */
import { createDb } from "@oracle/db/client";
import { createAuth, MAX_NAME_LENGTH } from "../auth";
import { loadConfig } from "../config";

const MIN_LENGTH = 10;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function readLine(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
    if (Buffer.concat(chunks).includes(10)) break;
  }
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0];
}

/** Returns an error message, or null when the account was created. Kept apart from the process handling so a test can call it. */
export async function createUser(db: Parameters<typeof createAuth>[0]["db"], opts: { secret: string; baseURL: string }, email: string, name: string, password: string): Promise<string | null> {
  const address = email.trim().toLowerCase();
  const display = name.trim().replace(/\s+/g, " ");
  if (!EMAIL.test(address)) return `"${email}" is not an email address.`;
  if (!display || display.length > MAX_NAME_LENGTH) return `The name must have 1 to ${MAX_NAME_LENGTH} characters.`;
  if (password.length < MIN_LENGTH) return `The password must be at least ${MIN_LENGTH} characters.`;
  // Sign-up being closed is for the public. The owner is running this on the server, so this process opens it for itself only.
  const auth = createAuth({ db, secret: opts.secret, baseURL: opts.baseURL, signupMode: "open", rateLimit: false });
  const ctx = await auth.$context;
  if (await ctx.internalAdapter.findUserByEmail(address, { includeAccounts: false })) return `There is already an account with the email ${address}.`;
  const hash = await ctx.password.hash(password);
  const user = await ctx.internalAdapter.createUser({ email: address, name: display, emailVerified: false }, { method: "email-password" });
  await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: hash });
  return null;
}

if (process.argv[1] && /create-user\.ts$/.test(process.argv[1].replace(/\\/g, "/"))) {
  const [email, ...nameParts] = process.argv.slice(2);
  if (!email) {
    console.error('Usage: sh create-user.sh friend@example.com "Friend Name"');
    process.exit(2);
  }
  const config = loadConfig();
  const { db, client } = createDb(config.databaseUrl);
  const password = await readLine();
  const name = nameParts.join(" ") || email.split("@")[0];
  const problem = await createUser(db, { secret: config.secret, baseURL: config.apiUrl }, email, name, password);
  await client.end({ timeout: 5 });
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  console.log(`Done. ${email.trim().toLowerCase()} can sign in now.`);
}
