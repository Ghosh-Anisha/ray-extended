import { describe, expect, it } from "vitest";
import { fakeClock, realClock, type Clock } from ".";

function clockContract(name: string, make: () => Clock) {
  describe(`Clock contract: ${name}`, () => {
    it("returns epoch ms that never go backwards", () => {
      const c = make();
      const a = c.now();
      const b = c.now();
      expect(Number.isInteger(a)).toBe(true);
      expect(b).toBeGreaterThanOrEqual(a);
    });
  });
}

clockContract("real", realClock);
clockContract("fake", () => fakeClock(Date.UTC(2026, 9, 12)));

describe("fake clock", () => {
  it("stands still until advanced", () => {
    const c = fakeClock(1_000);
    expect(c.now()).toBe(1_000);
    expect(c.advance(15 * 60_000)).toBe(1_000 + 15 * 60_000);
    expect(c.now()).toBe(1_000 + 15 * 60_000);
    c.set(72 * 3_600_000);
    expect(c.now()).toBe(72 * 3_600_000);
  });

  it("only moves forward", () => {
    const c = fakeClock(1_000);
    expect(() => c.advance(-1)).toThrow();
    expect(() => c.set(999)).toThrow();
  });
});
