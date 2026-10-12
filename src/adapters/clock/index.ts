// Every timer and timestamp reads this clock, never Date.now() directly, so
// the dev panel and tests can move time forward.
export interface Clock {
  now(): number;
}

export interface FakeClock extends Clock {
  advance(ms: number): number;
  set(at: number): void;
}

export function realClock(): Clock {
  return { now: () => Date.now() };
}

export function fakeClock(start: number): FakeClock {
  let at = start;
  return {
    now: () => at,
    advance(ms) {
      if (!Number.isFinite(ms) || ms < 0) throw new Error("A fake clock only moves forward");
      at += ms;
      return at;
    },
    set(next) {
      if (next < at) throw new Error("A fake clock only moves forward");
      at = next;
    },
  };
}

// The real clock behind the FakeClock shape, for code that takes one. It
// refuses to move: only the fake clock can be moved forward.
export function lockedRealClock(): FakeClock {
  return {
    now: () => Date.now(),
    advance() {
      throw new Error("The real clock cannot be moved forward");
    },
    set() {
      throw new Error("The real clock cannot be moved forward");
    },
  };
}
