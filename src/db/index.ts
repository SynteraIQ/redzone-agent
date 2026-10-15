import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

export type MemoryDatabase = NonNullable<ReturnType<typeof createMemoryDatabase>>;

let database: MemoryDatabase | null = null;
let connection: ReturnType<typeof postgres> | null = null;

function createMemoryDatabase() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) return null;

  connection = postgres(databaseUrl, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
  });
  return drizzle({ client: connection, schema });
}

export function getMemoryDatabase(): MemoryDatabase {
  if (!database) {
    database = createMemoryDatabase();
  }
  if (!database) throw new Error("PostgreSQL is not configured. Set DATABASE_URL to enable Memory.");
  return database;
}

export function isMemoryDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}
