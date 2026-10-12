import { openMigratedDb } from "@/db/client";
import { SEED_NOW, seed } from "@/db/seed";
import { createAdapters } from ".";
import { fakeClock } from "./clock";

// A seeded in-memory world with every adapter in mock mode.
export function seededAdapters() {
  const db = openMigratedDb(":memory:");
  seed(db);
  return createAdapters(db, fakeClock(SEED_NOW), { RAZORPAY_MODE: "mock" });
}
