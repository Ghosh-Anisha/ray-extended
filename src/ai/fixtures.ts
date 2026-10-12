// Replay fixtures: fixtures/ai/<job>/<key>.json. Each carries its label so
// the UI can say where an answer came from.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { fixtureKey } from "./key";
import { FIXTURE_LABELS, JOBS, type FixtureLabel, type JobName } from "./types";

export const DEFAULT_FIXTURES_DIR = path.join(process.cwd(), "fixtures", "ai");

const fixtureFile = z.object({
  job: z.enum(JOBS),
  key: z.string(),
  label: z.enum(FIXTURE_LABELS),
  prompt_version: z.string(),
  model: z.string().nullable(),
  input: z.unknown(),
  output: z.unknown(),
});
export type Fixture = z.infer<typeof fixtureFile>;

export const fixturePath = (dir: string, job: JobName, key: string) => path.join(dir, job, `${key}.json`);

// undefined on a miss. A file that is not a fixture at all counts as a miss
// with a problem, so it can never be served.
export function readFixture(dir: string, job: JobName, key: string): { fixture?: Fixture; problem?: string } {
  const file = fixturePath(dir, job, key);
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = fixtureFile.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (!parsed.success) return { problem: `Fixture ${file} is malformed` };
    if (parsed.data.job !== job || parsed.data.key !== key) return { problem: `Fixture ${file} is for a different call` };
    return { fixture: parsed.data };
  } catch {
    return { problem: `Fixture ${file} is not valid JSON` };
  }
}

export function writeFixture(
  dir: string,
  f: { job: JobName; label: FixtureLabel; promptVersion: string; model: string | null; input: unknown; output: unknown },
): string {
  const key = fixtureKey(f.job, f.input);
  const file = fixturePath(dir, f.job, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body: Fixture = {
    job: f.job,
    key,
    label: f.label,
    prompt_version: f.promptVersion,
    model: f.model,
    input: f.input,
    output: f.output,
  };
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + "\n");
  return file;
}
