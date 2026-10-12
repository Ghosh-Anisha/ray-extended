import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openMigratedDb } from "@/db/client";
import { createRepository } from "@/db/repository";
import type { ModelClient, ModelRequest } from "./client";
import { DEFAULT_FIXTURES_DIR } from "./fixtures";
import { createAi } from ".";
import type { AiRunMode } from "./types";

export function aiWorld(opts: { mode?: AiRunMode; fixturesDir?: string; client?: ModelClient } = {}) {
  const db = openMigratedDb(":memory:");
  const repo = createRepository(db);
  const ai = createAi({ repo, mode: opts.mode ?? "replay", fixturesDir: opts.fixturesDir ?? DEFAULT_FIXTURES_DIR, client: opts.client });
  return { db, repo, ai, calls: () => repo.aiCalls.list() };
}

// A model that answers from a function, and remembers what it was sent.
export function scriptedClient(answer: (req: ModelRequest, n: number) => unknown) {
  const seen: ModelRequest[] = [];
  const client: ModelClient = {
    async complete(req) {
      seen.push(req);
      return answer(req, seen.length);
    },
  };
  return { client, seen };
}

export function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ray-ai-"));
}

export function copyFixtures(to: string) {
  fs.cpSync(DEFAULT_FIXTURES_DIR, to, { recursive: true });
  return to;
}
