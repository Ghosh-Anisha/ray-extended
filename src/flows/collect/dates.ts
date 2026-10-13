// Reads a payment date out of a buyer's or merchant's words, in code:
// "by Friday", "on 20th", "20 Oct", "next week", "kal", "agle hafte Friday
// tak", "in 3 days", "month end". Returns the IST midnight of that day, or
// null when there is no date. Dates already past roll forward (a promise is
// always about a day still to come).
import { DAY, istMidnight } from "./stages";

const IST_MS = (5 * 60 + 30) * 60_000;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_HI: Record<string, number> = { somvar: 1, mangalvar: 2, budhvar: 3, guruvar: 4, shukravar: 5, shanivar: 6, ravivar: 0 };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const istParts = (ms: number) => {
  const d = new Date(ms + IST_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay() };
};
const istDate = (y: number, m: number, d: number) => Date.UTC(y, m, d) - IST_MS;

function weekdayIn(text: string): number | null {
  for (let i = 0; i < 7; i++) {
    const full = WEEKDAYS[i];
    if (new RegExp(`\\b(?:${full}|${full.slice(0, 3)})\\b`, "i").test(text)) return i;
  }
  for (const [w, i] of Object.entries(WEEKDAY_HI)) if (new RegExp(`\\b${w}\\b`, "i").test(text)) return i;
  return null;
}

export function readDate(text: string, now: number): number | null {
  const t = text.toLowerCase();
  const today = istMidnight(now);
  const p = istParts(now);
  const nextWeek = /\bnext week\b|\bagle hafte\b|\bagle week\b|\bnext wk\b/.test(t);

  // A day of the month: "20 Oct", "Oct 20", "20th", "on the 20th", "20/10".
  const named =
    t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/) ??
    t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (named) {
    const [day, mon] = /\d/.test(named[1]) ? [Number(named[1]), named[2]] : [Number(named[2]), named[1]];
    const m = MONTHS.indexOf(mon.slice(0, 3));
    if (day >= 1 && day <= 31 && m >= 0) {
      let at = istDate(p.y, m, day);
      if (at < today) at = istDate(p.y + 1, m, day);
      return at;
    }
  }
  const slash = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/);
  if (slash) {
    const day = Number(slash[1]);
    const m = Number(slash[2]) - 1;
    if (day >= 1 && day <= 31 && m >= 0 && m < 12) {
      let at = istDate(p.y, m, day);
      if (at < today) at = istDate(p.y + 1, m, day);
      return at;
    }
  }
  const ordinal = t.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/) ?? t.match(/\b(?:on|by|before|till|until)\s+(?:the\s+)?(\d{1,2})\b(?!\s*(?:days?|din|%|percent))/);
  if (ordinal) {
    const day = Number(ordinal[1]);
    if (day >= 1 && day <= 31) {
      let at = istDate(p.y, p.m, day);
      if (at < today) at = istDate(p.y, p.m + 1, day);
      return at;
    }
  }

  // "in 3 days", "3 din mein"
  const inDays = t.match(/\b(?:in|within)\s+(\d{1,2})\s+days?\b/) ?? t.match(/\b(\d{1,2})\s+din\b/);
  if (inDays) return today + Number(inDays[1]) * DAY;

  if (/\b(?:month end|end of (?:the )?month|mahine ke end)\b/.test(t)) return istDate(p.y, p.m + 1, 0);

  const wd = weekdayIn(t);
  if (wd !== null) {
    let ahead = (wd - p.wd + 7) % 7;
    if (ahead === 0) ahead = 7;
    if (nextWeek) {
      // The weekday in next calendar week (weeks start Monday).
      const toNextMonday = ((8 - p.wd) % 7) || 7;
      ahead = toNextMonday + ((wd + 6) % 7);
    }
    return today + ahead * DAY;
  }
  if (nextWeek) {
    // "Next week" alone: the Friday of next week.
    const toNextMonday = ((8 - p.wd) % 7) || 7;
    return today + (toNextMonday + 4) * DAY;
  }
  if (/\b(?:tomorrow|tmrw|kal)\b/.test(t)) return today + DAY;
  if (/\b(?:today|aaj|tonight|by eod|end of day)\b/.test(t)) return today;
  return null;
}
