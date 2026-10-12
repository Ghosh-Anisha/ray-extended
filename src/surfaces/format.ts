// Display helpers on top of the guards' formatters (design language
// section 1, "Numbers, dates, times").
import { formatDate, formatMoney, formatTime } from "@/guards/format";

export { formatDate, formatMoney, formatTime };

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Within a day: 14 min ago, 3 hr ago. Older: 6 Oct.
export function age(at: number, now: number): string {
  const d = Math.max(0, now - at);
  if (d < MIN) return "just now";
  if (d < HOUR) return `${Math.floor(d / MIN)} min ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)} hr ago`;
  return formatDate(at);
}

// 6 Oct, 7:52 PM
export const dateTime = (at: number) => `${formatDate(at)}, ${formatTime(at)}`;

// pay_Q8x… : the full id goes in a title for hover or tap.
export function shortId(id: string): string {
  const [prefix, rest] = id.includes("_") ? [id.slice(0, id.indexOf("_") + 1), id.slice(id.indexOf("_") + 1)] : ["", id];
  return rest.length <= 4 ? id : `${prefix}${rest.slice(0, 3)}…`;
}

// "9:42" and "9 min 42 s left": countdowns are also given as text.
export function countdown(ms: number): { clock: string; words: string } {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return { clock: `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`, words: `${h} hr ${m} min` };
  return { clock: `${m}:${String(sec).padStart(2, "0")}`, words: m > 0 ? `${m} min ${sec} s` : `${sec} s` };
}

export const firstName = (name: string) => name.split(/\s+/)[0];

export const money = (minor: number | null | undefined, currency = "INR") => (minor === null || minor === undefined ? "Amount not known yet" : formatMoney(minor, currency));

// Store order numbers are kept with their "#" ("#1234"); show them once.
export const orderLabel = (n: string) => (n.startsWith("#") ? n : `#${n}`);
