import fs from "node:fs";
import { DEFAULT_DB_PATH, openMigratedDb } from "./client";

for (const suffix of ["", "-wal", "-shm", "-journal"]) {
  fs.rmSync(DEFAULT_DB_PATH + suffix, { force: true });
}

const db = openMigratedDb();
db.$client.close();
console.log(`Reset ${DEFAULT_DB_PATH} and applied migrations`);
