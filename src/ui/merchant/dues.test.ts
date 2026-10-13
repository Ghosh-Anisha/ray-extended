import { describe, expect, it } from "vitest";
import { duesExampleSummary } from "./dues";

describe("simulated dues arithmetic", () => {
  it("keeps November rent out of October and reconciles the remaining cash", () => {
    const october = duesExampleSummary(Date.parse("2026-10-13T10:00:00+05:30"));
    expect(october).toEqual({ openingCash: 4_200_000, dueThisMonth: 2_820_000, afterThisMonth: 1_380_000 });
  });

  it("uses a different due total for November", () => {
    const november = duesExampleSummary(Date.parse("2026-11-13T10:00:00+05:30"));
    expect(november).toEqual({ openingCash: 4_200_000, dueThisMonth: 2_800_000, afterThisMonth: 1_400_000 });
  });
});
