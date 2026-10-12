// Quick steps for "Move clock forward" on the dev panel.
export const CLOCK_PRESETS: { label: string; ms: number }[] = [
  { label: "15 min", ms: 15 * 60_000 },
  { label: "30 min", ms: 30 * 60_000 },
  { label: "2 h", ms: 2 * 3_600_000 },
  { label: "48 h", ms: 48 * 3_600_000 },
  { label: "72 h", ms: 72 * 3_600_000 },
];
