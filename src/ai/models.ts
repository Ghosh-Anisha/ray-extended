// Small model for understand and verify, a stronger one for the rest.
import type { JobName } from "./types";

export const SMALL_MODEL = "claude-haiku-5-5";
export const STRONG_MODEL = "claude-opus-5-5";

export const MODEL_FOR: Record<JobName, string> = {
  understand: SMALL_MODEL,
  verify: SMALL_MODEL,
  investigate: STRONG_MODEL,
  decide: STRONG_MODEL,
  converse: STRONG_MODEL,
  write: STRONG_MODEL,
  learn: STRONG_MODEL,
};
