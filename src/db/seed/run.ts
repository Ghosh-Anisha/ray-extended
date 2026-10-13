// npm run db:seed: a fresh database holding the demo world (the same thing
// Reset demo does). The old database file is replaced.
import fs from "node:fs";
import { markDemoSeeded } from "@/demo/world";
import { DEFAULT_DB_PATH, openMigratedDb } from "../client";
import { seedDemo } from "./demo";

async function main() {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(DEFAULT_DB_PATH + suffix, { force: true });
  const db = openMigratedDb();
  const started = Date.now();
  const { now } = await seedDemo(db);
  markDemoSeeded(db, now);
  db.$client.close();
  console.log(`Seeded the demo world in ${Date.now() - started} ms: Leafy Bakes on ${new Date(now).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
