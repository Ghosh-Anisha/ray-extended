// The demo clock is kept in the database, so a restart does not send the story
// back in time, and a database seeded by an older version is rebuilt.
import { describe, expect, it } from "vitest";
import { openMigratedDb } from "@/db/client";
import { DEMO_NOW } from "@/db/seed";
import { markDemoSeeded, persistentClock } from "./world";

describe("the persistent demo clock", () => {
  it("starts at Tue 13 Oct 10:00 AM and remembers where it moved to", () => {
    const db = openMigratedDb(":memory:");
    const first = persistentClock(db);
    expect(first.now()).toBe(DEMO_NOW);
    first.advance(2 * 3_600_000);
    const afterRestart = persistentClock(db);
    expect(afterRestart.now()).toBe(DEMO_NOW + 2 * 3_600_000);
    expect(() => afterRestart.set(DEMO_NOW)).toThrow(/only moves forward/);
    db.$client.close();
  });

  it("is set by the seed", () => {
    const db = openMigratedDb(":memory:");
    markDemoSeeded(db, DEMO_NOW);
    expect(persistentClock(db).now()).toBe(DEMO_NOW);
    markDemoSeeded(db, DEMO_NOW + 60_000);
    expect(persistentClock(db).now()).toBe(DEMO_NOW + 60_000);
    db.$client.close();
  });
});
