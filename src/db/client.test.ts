import { sql } from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "./client";

describe("openDb", () => {
  it("opens an in-memory SQLite database", () => {
    const db = openDb(":memory:");
    const row = db.get<{ one: number }>(sql`select 1 as one`);
    expect(row.one).toBe(1);
    db.$client.close();
  });

  it("explains database path and volume permissions when the parent is not writable as a directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ray-db-path-"));
    const parentFile = path.join(dir, "not-a-directory");
    fs.writeFileSync(parentFile, "fixture");
    expect(() => openDb(path.join(parentFile, "ray.db"))).toThrow(/RAY_DB_PATH.*persistent, writable disk.*read and write/i);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reopens the same file with its state intact", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ray-db-persist-"));
    const file = path.join(dir, "ray.db");
    const first = openDb(file);
    first.$client.exec("create table persistence_check (value text); insert into persistence_check values ('saved');");
    first.$client.close();
    const second = openDb(file);
    expect(second.get<{ value: string }>(sql`select value from persistence_check`).value).toBe("saved");
    second.$client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
