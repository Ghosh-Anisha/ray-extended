// Live calls never see personal data. Names, phones, emails and card numbers
// become tokens like [NAME_1] before the call and are put back after.
export type Masker = { mask<T>(value: T): T; unmask<T>(value: T): T };

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 13 to 19 digits, optionally in groups of 4: card numbers. UTRs are 12 digits.
const CARD = /\b(?:\d[ -]?){12,18}\d\b/g;
// Indian mobiles with or without +91, and other + prefixed numbers.
const PHONE = /(?:\+\d{1,3}[ -]?)?\b[6-9]\d{9}\b|\+\d{10,14}\b/g;

function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  }
  return value;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function createMasker(names: string[] = []): Masker {
  const toToken = new Map<string, string>();
  const toValue = new Map<string, string>();
  const counts: Record<string, number> = {};
  const token = (kind: string, raw: string) => {
    let t = toToken.get(raw);
    if (!t) {
      counts[kind] = (counts[kind] ?? 0) + 1;
      t = `[${kind}_${counts[kind]}]`;
      toToken.set(raw, t);
      toValue.set(t, raw);
    }
    return t;
  };
  // Longest names first, so "Priya Sharma" wins over "Priya".
  const sorted = [...new Set(names.map((n) => n.trim()).filter((n) => n.length > 1))].sort((a, b) => b.length - a.length);
  const nameRe = sorted.length ? new RegExp(`\\b(?:${sorted.map(escape).join("|")})\\b`, "g") : null;

  const maskString = (s: string) => {
    let out = s.replace(EMAIL, (m) => token("EMAIL", m));
    out = out.replace(CARD, (m) => token("CARD", m));
    out = out.replace(PHONE, (m) => token("PHONE", m));
    if (nameRe) out = out.replace(nameRe, (m) => token("NAME", m));
    return out;
  };
  const unmaskString = (s: string) => s.replace(/\[(?:EMAIL|CARD|PHONE|NAME)_\d+\]/g, (t) => toValue.get(t) ?? t);

  return {
    mask: <T>(value: T) => mapStrings(value, maskString) as T,
    unmask: <T>(value: T) => mapStrings(value, unmaskString) as T,
  };
}
