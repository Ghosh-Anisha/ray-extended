// The running demo: seeded once (first load or Reset demo), never per
// request. The clock is stored in the database, so a restart keeps the time
// the story reached. Pages get the adapters from getAdapters(); this module
// puts the seeded ones there.
import fs from "node:fs";
import { eq } from "drizzle-orm";
import { createAdapters, type Adapters } from "@/adapters";
import type { FakeClock } from "@/adapters/clock";
import { lockedRealClock } from "@/adapters/clock";
import { DEFAULT_DB_PATH, openMigratedDb, type Db } from "@/db/client";
import { createRepository } from "@/db/repository";
import { DEMO_NOW } from "@/db/seed";
import { DEMO_SEED_VERSION, seedDemo } from "@/db/seed/demo";
import { GLOBAL_SETTINGS_ID } from "@/guards/kill-switch";
import { getEngine } from "@/engine";
import * as s from "@/db/schema";

const DEMO_MARKER = "demo_world"; // global_settings.updated_at holds the seed version
const CLOCK_ROW = "demo_clock"; // global_settings.updated_at holds the demo clock

type Holder = { __rayAdapters?: Adapters; __rayEngine?: { stop(): void }; __rayDemoReady?: Promise<void> };
const holder = globalThis as unknown as Holder;

// A fake clock that remembers where it is in the database.
export function persistentClock(db: Db, fallback: number = DEMO_NOW): FakeClock {
  const row = db.select().from(s.globalSettings).where(eq(s.globalSettings.id, CLOCK_ROW)).get();
  let at = row?.updated_at ?? fallback;
  const save = () =>
    db
      .insert(s.globalSettings)
      .values({ id: CLOCK_ROW, kill_switch: false, updated_at: at })
      .onConflictDoUpdate({ target: s.globalSettings.id, set: { updated_at: at } })
      .run();
  return {
    now: () => at,
    advance(ms) {
      if (!Number.isFinite(ms) || ms < 0) throw new Error("A fake clock only moves forward");
      at += ms;
      save();
      return at;
    },
    set(next) {
      if (next < at) throw new Error("A fake clock only moves forward");
      at = next;
      save();
    },
  };
}

export function markDemoSeeded(db: Db, now: number) {
  for (const [id, updated_at] of [[DEMO_MARKER, DEMO_SEED_VERSION], [CLOCK_ROW, now]] as const) {
    db.insert(s.globalSettings)
      .values({ id, kill_switch: false, updated_at })
      .onConflictDoUpdate({ target: s.globalSettings.id, set: { updated_at } })
      .run();
  }
}

const isSeeded = (db: Db) => db.select().from(s.globalSettings).where(eq(s.globalSettings.id, DEMO_MARKER)).get()?.updated_at === DEMO_SEED_VERSION;

function removeDbFiles() {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(DEFAULT_DB_PATH + suffix, { force: true });
}

function install(db: Db) {
  const real = process.env.CLOCK_MODE === "real";
  const clock = real ? lockedRealClock() : persistentClock(db);
  holder.__rayAdapters = createAdapters(db, clock, process.env, real ? "real" : "fake");
  // Subscribes the engine to webhooks; on the real clock it starts the tick.
  getEngine();
}

async function build(): Promise<void> {
  removeDbFiles();
  const db = openMigratedDb();
  const { now } = await seedDemo(db);
  markDemoSeeded(db, now);
  install(db);
}

async function boot(): Promise<void> {
  if (holder.__rayAdapters && isSeeded(holder.__rayAdapters.db)) return;
  const db = openMigratedDb();
  if (isSeeded(db)) {
    install(db);
    return;
  }
  db.$client.close();
  await build();
}

// Idempotent and cheap after the first call.
export function ensureDemoWorld(): Promise<void> {
  holder.__rayDemoReady ??= boot().catch((e) => {
    holder.__rayDemoReady = undefined;
    throw e;
  });
  return holder.__rayDemoReady;
}

// Reset demo: a fresh database, seeded again. The story starts over.
export async function resetDemoWorld(): Promise<void> {
  await ensureDemoWorld();
  holder.__rayEngine?.stop();
  holder.__rayEngine = undefined;
  holder.__rayAdapters?.db.$client.close();
  holder.__rayAdapters = undefined;
  holder.__rayDemoReady = build().catch((e) => {
    holder.__rayDemoReady = undefined;
    throw e;
  });
  await holder.__rayDemoReady;
}

export function demoState(a: Adapters) {
  const repo = createRepository(a.db);
  return {
    now: a.clock.now(),
    clockMode: a.clockMode,
    globalKillSwitch: repo.globalSettings.get(GLOBAL_SETTINGS_ID)?.kill_switch ?? false,
  };
}
