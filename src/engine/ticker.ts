// On the real clock, nobody moves time by hand, so timers fire from an
// interval tick. On the fake clock this does nothing: the dev panel's
// "Move clock forward" runs the tick instead.
import type { Engine } from "./engine";

export const REAL_CLOCK_TICK_MS = 30_000;

export function startRealClockTicker(
  clockMode: "fake" | "real",
  engine: Pick<Engine, "tick">,
  everyMs: number = REAL_CLOCK_TICK_MS,
): (() => void) | null {
  if (clockMode !== "real") return null;
  let running = false;
  const handle = setInterval(async () => {
    if (running) return; // a slow tick is never doubled up
    running = true;
    try {
      await engine.tick();
    } catch (e) {
      console.error("Timer tick failed:", e instanceof Error ? e.message : "unknown error");
    } finally {
      running = false;
    }
  }, everyMs);
  handle.unref?.();
  return () => clearInterval(handle);
}
