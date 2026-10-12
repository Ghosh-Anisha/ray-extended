// Code checks on every draft RAY writes. Rule 6: every number in an
// outgoing message must exist in the case data. Design language section 1:
// some words are never shown to merchants or customers.

// Digits with optional grouping (1,299 or 14,20,000), decimals (14.2) or a
// time (8:30). Commas are grouping, so 1,299 and 1299 are the same number.
const NUMBER = /\d+(?:[,.:]\d+)*/g;

function numberTokens(text: string): string[] {
  return (text.match(NUMBER) ?? []).map((raw) => {
    const t = raw.replace(/,(?=\d)/g, "").replace(/[.:]$/, "");
    if (/^\d+(\.\d+)?$/.test(t)) return String(Number(t));
    return t;
  });
}

// Every number in the facts: numeric values and the numbers inside strings.
// Times also count as their parts, so "7:52 PM" in the facts allows "7:52".
export function factNumbers(facts: unknown): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v)) out.add(String(v));
    else if (typeof v === "string") for (const t of numberTokens(v)) out.add(t);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(facts);
  return out;
}

// The numbers in a draft that do not appear anywhere in the facts.
export function ungroundedNumbers(draft: string, facts: unknown): string[] {
  const known = factNumbers(facts);
  return [...new Set(numberTokens(draft).filter((n) => !known.has(n)))];
}

// Section 1, "Words never shown to merchants or customers", plus the promise
// section 2 bans in customer messages.
export const BANNED_WORDS = [
  "webhook",
  "cron",
  "HTTP 200",
  "idempotency",
  "payload",
  "orchestrator",
  "agent",
  "LLM",
  "AI model",
  "MCP",
  "situation B",
  "you won't be charged twice",
] as const;

export function bannedWordsIn(text: string): string[] {
  const lower = text.toLowerCase().replace(/[’‘]/g, "'");
  return BANNED_WORDS.filter((w) => new RegExp(`\\b${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(lower));
}

export const hasEmDash = (text: string) => text.includes("—");
export const hasLink = (text: string) => /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|in|io|me|link|ly)\b\/?/i.test(text);
