/** Seeds the provider catalog into the database in DATABASE_URL. Usage: npm run db:seed */
import { createDb } from "../client";
import { seedProviders } from "./index";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set. See .env.example.");

const { db, client } = createDb(url, { max: 1 });
try {
  console.log(`Seeded ${await seedProviders(db)} providers.`);
} finally {
  await client.end();
}
