// Reads a buyer's reply, in code (Step 11, "Read replies"). A voice note
// arrives as its transcript and is read exactly like text. The words are
// data: RAY reads what the buyer says and never does what the message tells
// it to (rule 5). Anything this can't place is "unclear" and goes to the
// merchant as one question.
import { readDate } from "./dates";
import type { Invoice } from "./stages";

export const REPLY_TYPES = [
  "promise",
  "dispute",
  "document_request",
  "says_paid",
  "part_payment",
  "wrong_person",
  "hardship",
  "unclear",
] as const;
export type ReplyType = (typeof REPLY_TYPES)[number];

export type Reading = {
  type: ReplyType;
  // When they say they'll pay (IST midnight), if they named one.
  date: number | null;
  // An amount they wrote, in paise.
  amount: number | null;
  utr: string | null;
  // The buyer's invoices the message names (by number), if any.
  invoiceIds: string[];
  // Dispute: the GST number or rate is wrong (a corrected invoice), else a
  // part of the goods (a credit note).
  correction: boolean;
  // Wrong person: a new address written in the message, for the merchant to approve.
  newEmail: string | null;
  newPhone: string | null;
  // Document request: what they asked for.
  document: string | null;
  // Merchant-facing reason, one plain line.
  why: string;
};

const has = (re: RegExp, t: string) => re.test(t);

// "₹20,000", "Rs. 20000", "INR 1,20,000", "20k", "20 thousand", "1.5 lakh".
export function readAmount(text: string): number | null {
  const t = text.replace(/,/g, "");
  const lakh = t.match(/(\d+(?:\.\d+)?)\s*(?:lakh|lac|l)\b/i);
  if (lakh) return Math.round(Number(lakh[1]) * 100_000 * 100);
  const k = t.match(/(?:₹|rs\.?|inr)?\s*(\d+(?:\.\d+)?)\s*(?:k|thousand|hazaar|hazar)\b/i);
  if (k) return Math.round(Number(k[1]) * 1_000 * 100);
  const cur = t.match(/(?:₹|rs\.?\s*|inr\s*)(\d+(?:\.\d{1,2})?)/i);
  if (cur) return Math.round(Number(cur[1]) * 100);
  return null;
}

// A bank reference: 12 to 22 letters and digits with at least 6 digits.
export function readUtr(text: string): string | null {
  for (const m of text.matchAll(/\b[A-Z0-9]{12,22}\b/gi)) {
    if ((m[0].match(/\d/g) ?? []).length >= 6) return m[0].toUpperCase();
  }
  return null;
}

// Invoice numbers named in the text: "PR/26-27/2402", "INV-2402", "invoice 2402", "#2402".
export function invoicesNamed(text: string, invoices: Pick<Invoice, "id" | "number">[]): string[] {
  const out = new Set<string>();
  for (const inv of invoices) {
    const tail = inv.number.match(/(\d{3,})$/)?.[1];
    if (text.includes(inv.number)) out.add(inv.id);
    else if (tail && new RegExp(`(?:inv(?:oice)?\\s*(?:no\\.?|number)?\\s*[-#:/]?\\s*|#|/)${tail}\\b`, "i").test(text)) out.add(inv.id);
  }
  return [...out];
}

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const PHONE = /(?:\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/;

export function readReply(text: string, now: number, invoices: Pick<Invoice, "id" | "number">[]): Reading {
  const t = text.toLowerCase();
  const date = readDate(text, now);
  const amount = readAmount(text);
  const utr = readUtr(text);
  const base = { date, amount, utr, invoiceIds: invoicesNamed(text, invoices), correction: false, newEmail: null, newPhone: null, document: null };
  const r = (type: ReplyType, why: string, extra: Partial<Reading> = {}): Reading => ({ ...base, type, why, ...extra });

  if (has(/\bwrong person\b|\bnot the right person\b|\bi (?:don'?t|do not) handle\b|\bno longer (?:with|handles?|handling|work)\b|\bnot my department\b|\bplease (?:contact|write to|email|reach)\b|\bgalat (?:aadmi|insaan|number|person)\b/, t)) {
    const email = text.match(EMAIL)?.[0] ?? null;
    const phone = text.match(PHONE)?.[0]?.replace(/[\s-]/g, "") ?? null;
    return r("wrong_person", "They say they're the wrong person to ask.", {
      newEmail: email ? email.toLowerCase() : null,
      newPhone: phone ? (phone.startsWith("+") ? phone : `+91${phone.slice(-10)}`) : null,
    });
  }
  if (has(/\bgst(?:in)?\b[^.?!]*\b(?:wrong|incorrect|mistake|galat)\b|\b(?:wrong|incorrect)\b[^.?!]*\bgst(?:in)?\b|\b(?:rate|price|hsn)\b[^.?!]*\b(?:wrong|incorrect)\b/, t)) {
    return r("dispute", "They say a detail on the invoice is wrong.", { correction: true });
  }
  if (has(/\bdamaged\b|\bdefective\b|\bbroken\b|\bshort (?:supply|delivered|delivery|quantity|by \d)|\bnot received\b|\b(?:didn'?t|did not|never) (?:receive|get)\b|\bdispute\b|\bquality issue\b|\breturned\b|\bkharab\b|\btoota\b/, t)) {
    return r("dispute", "They're disputing part of the invoice.");
  }
  if (has(/\bcash ?flow\b|\btight\b|\bdifficult\b|\bhard time\b|\bstruggling\b|\bcan'?t pay (?:the )?(?:full|whole|all)\b|\bcannot pay (?:the )?(?:full|whole|all)\b|\binstal+ments?\b|\bin parts\b|\bemi\b|\bkisht\b|\bpaise nahi\b|\bmushkil\b|\bthoda time\b/, t)) {
    return r("hardship", "They say money is tight and asked for time.");
  }
  if (has(/\bpart(?:ial)? payment\b|\bpaid (?:half|part|some)\b|\b(?:rest|balance|remaining)\b[^.?!]*\b(?:by|on|next|in)\b|\bpaying (?:part|half|some)\b/, t)) {
    return r("part_payment", "They paid part and gave a date for the rest.");
  }
  if (has(/\balready paid\b|\b(?:have|has|we|i) (?:already )?(?:paid|transferred|sent|released)\b|\bpaid (?:it|this|the|yesterday|today|on|via)\b|\btransferred\b|\bsent the payment\b|\bpayment (?:is |has been )?(?:done|made|sent|released|processed)\b|\bkar diya\b|\bho gaya\b|\bbhej diya\b|\b(?:neft|rtgs|imps|utr)\b/, t)) {
    return r("says_paid", "They say they've paid.");
  }
  const doc = t.match(/\b(?:copy of|send (?:us |me )?(?:the |a )?|resend (?:the )?|need (?:the |a )?|share (?:the |a )?)(invoice|po|purchase order|ledger|statement|delivery challan|challan|e-?way bill|gst invoice|credit note|pod|proof of delivery)\b/);
  if (doc) return r("document_request", `They asked for the ${doc[1]}.`, { document: doc[1] });
  if (date !== null && has(/\bwill\b|\bshall\b|\bby\b|\bpay\b|\bclear\b|\brelease\b|\bprocess\b|\bkar denge\b|\bde denge\b|\bho jayega\b|\btak\b|\bon\b/, t)) {
    return r("promise", "They gave a date to pay.");
  }
  return r("unclear", "I couldn't tell what they mean.");
}
