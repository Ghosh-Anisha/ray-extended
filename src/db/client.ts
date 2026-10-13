import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

export const DEFAULT_DB_PATH = process.env.RAY_DB_PATH || path.join(process.cwd(), "data", "ray.db");
export const MIGRATIONS_DIR = path.join(process.cwd(), "src", "db", "migrations");

export function openDb(file: string = DEFAULT_DB_PATH) {
  if (file !== ":memory:") {
    try {
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    } catch (cause) {
      throw databaseOpenError(file, cause);
    }
  }
  let sqlite: InstanceType<typeof Database>;
  try {
    sqlite = new Database(file);
  } catch (cause) {
    throw databaseOpenError(file, cause);
  }
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

function databaseOpenError(file: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `RAY could not open SQLite database at "${file}" (${detail}). Set RAY_DB_PATH to an absolute path on a persistent, writable disk, create/mount the parent directory before startup, and ensure the Node process can read and write it. Serverless functions with separate temporary disks are not supported because cases and approvals must share one database.`,
    { cause },
  );
}

export type Db = ReturnType<typeof openDb>;

export function migrateDb(db: Db) {
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return db;
}

export function openMigratedDb(file: string = DEFAULT_DB_PATH) {
  return migrateDb(openDb(file));
}
