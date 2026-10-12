// Replay fixtures are keyed by a hash of the job and its normalised input,
// so the same question always finds the same recorded answer.
import { createHash } from "node:crypto";

// Sorted keys, undefined dropped, whitespace in strings collapsed.
export function normalise(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = normalise(v);
    }
    return out;
  }
  return value;
}

export function fixtureKey(job: string, input: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify({ job, input: normalise(input) }))
    .digest("hex")
    .slice(0, 24);
}
