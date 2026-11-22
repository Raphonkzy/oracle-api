import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.url(),
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  /** Public URL of this API, as the phone and browser reach it. */
  API_URL: z.url().default("http://localhost:3200"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3200),
  /** closed: only the first user can sign up. open: anyone can. */
  SIGNUP_MODE: z.enum(["closed", "open"]).default("closed"),
  /** Comma-separated browser origins allowed to call the API (the web build). Native apps do not need CORS. */
  CORS_ORIGINS: z.string().default(""),
  /** Apply database migrations and refresh the provider catalog when the server starts. Both are safe to repeat. */
  RUN_MIGRATIONS: z.enum(["true", "false"]).default("true"),
  /** The AI assistant. Any OpenAI-compatible endpoint. Leave AI_API_KEY empty to switch it off. */
  AI_BASE_URL: z.string().default(""),
  AI_API_KEY: z.string().default(""),
  AI_MODEL: z.string().default("deepseek-v4.1-flash"),
  /** Assistant calls (chat and summary) each person may make an hour. */
  AI_RATE_PER_HOUR: z.coerce.number().int().min(1).max(1000).default(40),
  /** Outgoing email, used for the password reset code. Leave SMTP_HOST empty to switch "Forgot password" off. */
  SMTP_HOST: z.string().default(""),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  /** true for port 465 (TLS from the start). false for 587 (STARTTLS). Default: true only on 465. */
  SMTP_SECURE: z.enum(["true", "false", ""]).default(""),
  SMTP_USER: z.string().default(""),
  SMTP_PASSWORD: z.string().default(""),
  /** The sender, for example: Oracle <you@gmail.com> */
  SMTP_FROM: z.string().default(""),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment variables:\n${issues}\nSee .env.example.`);
  }
  const c = parsed.data;
  return {
    databaseUrl: c.DATABASE_URL,
    secret: c.BETTER_AUTH_SECRET,
    apiUrl: c.API_URL,
    port: c.PORT,
    signupMode: c.SIGNUP_MODE,
    corsOrigins: c.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
    runMigrations: c.RUN_MIGRATIONS === "true",
    ai: c.AI_API_KEY.trim() && c.AI_BASE_URL.trim() ? { baseUrl: c.AI_BASE_URL.trim(), apiKey: c.AI_API_KEY.trim(), model: c.AI_MODEL.trim() } : null,
    aiPerHour: c.AI_RATE_PER_HOUR,
    smtp: c.SMTP_HOST.trim() && c.SMTP_FROM.trim() ? { host: c.SMTP_HOST.trim(), port: c.SMTP_PORT, secure: c.SMTP_SECURE ? c.SMTP_SECURE === "true" : c.SMTP_PORT === 465, user: c.SMTP_USER.trim(), password: c.SMTP_PASSWORD, from: c.SMTP_FROM.trim() } : null,
  };
}

export type Config = ReturnType<typeof loadConfig>;
