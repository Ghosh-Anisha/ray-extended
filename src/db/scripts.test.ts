import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDb } from "./client";

// Runs the real npm scripts against a scratch database, never data/ray.db.
describe("npm run db:reset && npm run db:seed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ray-db-"));
  const file = path.join(dir, "ray.db");
  const run = (script: string) =>
    execFileSync("npm", ["run", "--silent", script], { env: { ...process.env, RAY_DB_PATH: file }, encoding: "utf8" });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("builds the database from scratch, even over an existing one", () => {
    for (let i = 0; i < 2; i++) {
      run("db:reset");
      run("db:seed");
      const db = openDb(file);
      const count = (t: string) => (db.$client.prepare(`select count(*) as n from ${t}`).get() as { n: number }).n;
      expect(count("merchants")).toBe(13);
      // db:seed builds the demo world (docs/ui-rebuild.md section 4): PackRight's 38 invoices
      // plus Leafy Bakes' 14, and Leafy's 46 cases, 4 of them waiting on the merchant.
      expect(count("invoices")).toBe(52);
      expect(count("cases")).toBe(46);
      expect(count("cases where state = 'waiting_merchant'")).toBe(4);
      expect(count("case_events")).toBeGreaterThan(0);
      db.$client.close();
    }
  }, 60_000);
});
