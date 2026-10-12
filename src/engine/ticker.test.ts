import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REAL_CLOCK_TICK_MS, startRealClockTicker } from "./ticker";

describe("real-clock ticker", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("ticks every 30 seconds on the real clock", async () => {
    const engine = { tick: vi.fn(async () => ({ fired: [] })) };
    const stop = startRealClockTicker("real", engine)!;
    await vi.advanceTimersByTimeAsync(REAL_CLOCK_TICK_MS - 1);
    expect(engine.tick).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(engine.tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * REAL_CLOCK_TICK_MS);
    expect(engine.tick).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(5 * REAL_CLOCK_TICK_MS);
    expect(engine.tick).toHaveBeenCalledTimes(3);
  });

  it("does nothing on the fake clock", async () => {
    const engine = { tick: vi.fn(async () => ({ fired: [] })) };
    expect(startRealClockTicker("fake", engine)).toBeNull();
    await vi.advanceTimersByTimeAsync(10 * REAL_CLOCK_TICK_MS);
    expect(engine.tick).not.toHaveBeenCalled();
  });

  it("keeps ticking after a failed tick, and never overlaps a slow one", async () => {
    let release: () => void = () => {};
    const engine = {
      tick: vi
        .fn()
        .mockRejectedValueOnce(new Error("db busy"))
        .mockImplementationOnce(() => new Promise((r) => (release = () => r({ fired: [] }))))
        .mockResolvedValue({ fired: [] }),
    };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const stop = startRealClockTicker("real", engine)!;
    await vi.advanceTimersByTimeAsync(REAL_CLOCK_TICK_MS); // fails
    await vi.advanceTimersByTimeAsync(REAL_CLOCK_TICK_MS); // slow tick starts
    await vi.advanceTimersByTimeAsync(3 * REAL_CLOCK_TICK_MS); // skipped while slow
    expect(engine.tick).toHaveBeenCalledTimes(2);
    release();
    await vi.advanceTimersByTimeAsync(REAL_CLOCK_TICK_MS);
    expect(engine.tick).toHaveBeenCalledTimes(3);
    expect(err).toHaveBeenCalledWith("Timer tick failed:", "db busy");
    stop();
    err.mockRestore();
  });
});
