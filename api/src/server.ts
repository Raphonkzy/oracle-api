import { serve } from "@hono/node-server";
import { createDb } from "@oracle/db/client";
import { runMigrations } from "@oracle/db/migrate";
import { seedProviders } from "@oracle/db/seed";
import { createApp } from "./app";
import { createAiClient } from "./ai/client";
import { createAuth } from "./auth";
import { createSmtpMailer } from "./mailer";
import { loadConfig } from "./config";

const config = loadConfig();
if (config.runMigrations) {
  await runMigrations(config.databaseUrl);
  console.log("Database migrations are up to date.");
}
if (config.apiUrl.startsWith("http://") && !/^http:\/\/(localhost|127\.0\.0\.1|10\.|192\.168\.)/.test(config.apiUrl)) {
  console.warn(`API_URL is ${config.apiUrl}. Use the public https:// address in production so session cookies are secure.`);
}
const { db, client } = createDb(config.databaseUrl);
if (config.runMigrations) await seedProviders(db);
const mailer = config.smtp ? createSmtpMailer(config.smtp) : null;
const auth = createAuth({
  db,
  secret: config.secret,
  baseURL: config.apiUrl,
  signupMode: config.signupMode,
  trustedOrigins: config.corsOrigins,
  mailer,
});
const app = createApp({ auth, db, signupMode: config.signupMode, corsOrigins: config.corsOrigins, log: true, ai: config.ai ? createAiClient(config.ai) : null, aiPerHour: config.aiPerHour, passwordReset: mailer !== null });

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Oracle API listening on http://localhost:${info.port} (sign-up: ${config.signupMode}, assistant: ${config.ai ? config.ai.model : "off"}, password reset email: ${mailer ? "on" : "off"})`);
});

async function shutdown() {
  server.close();
  await client.end({ timeout: 5 });
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
