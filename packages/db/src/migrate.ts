/** Apply migrations. pgvector must exist before the first migration creates vector columns. */
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./index";

const db = createDb();
await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
console.log("migrations applied");
await db.$client.end();
