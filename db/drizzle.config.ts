import { defineConfig } from "drizzle-kit";

// drizzle-kit does not read .env by itself.
try {
  process.loadEnvFile("../.env");
} catch {
  // No .env file: rely on variables already in the environment.
}

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
  strict: true,
  verbose: true,
});
