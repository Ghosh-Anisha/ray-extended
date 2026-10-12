import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { openDb } from "./client";

describe("openDb", () => {
  it("opens an in-memory SQLite database", () => {
    const db = openDb(":memory:");
    const row = db.get<{ one: number }>(sql`select 1 as one`);
    expect(row.one).toBe(1);
    db.$client.close();
  });
});
