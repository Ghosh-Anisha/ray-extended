// Every message Collect sends to a buyer, and the lines it shows the
// merchant. Built in code from the case data (design language section 2,
// "To B2B buyers": polite and factual; firmness comes from facts, not
// adjectives). Each builder also returns the numbers it used, which the flow
// writes on the case as a case_facts note before sending, so the grounding
// guard can check every number (rule 6).
//
// Buyers see exact amounts (₹1,23,400), because an invoice reminder has to
// match their books to the rupee; merchant screens use the short form
// (₹1.2 lakh) from design language section 1.
import { firstNameOf } from "@/adapters/voice";
import { formatDate, formatMoney } from "@/guards";
import { groupIndian } from "@/guards/format";
import { daysOverdue, MSME_DAYS, type Buyer, type Invoice } from "./stages";

export type Built = { body: string; facts: Record<string, string> };
export type Line = Pick<Invoice, "id" | "number" | "due_date" | "accepted_at"> & { owed: number };

export const exact = (minor: number) => `₹${groupIndian(Number((minor / 100).toFixed(2)))}`;
const total = (lines: Line[]) => lines.reduce((n, l) => n + l.owed, 0);
const and = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const signOff = (merchant: string) => `Thank you,\n${merchant}`;

function factsFor(lines: Line[], now: number, extra: Record<string, string> = {}): Record<string, string> {
  const f: Record<string, string> = { total_exact: exact(total(lines)), invoice_count: String(lines.length), ...extra };
  for (const l of lines) {
    f[`owed_${l.number}`] = exact(l.owed);
    f[`days_overdue_${l.number}`] = String(Math.max(0, daysOverdue(l, now)));
  }
  return f;
}

const itemDue = (l: Line) => `${l.number} for ${exact(l.owed)}`;

export function beforeDue(b: Buyer, merchant: string, lines: Line[], link: string | null, now: number): Built {
  const items = and(lines.map((l) => `${itemDue(l)} is due on ${formatDate(l.due_date)}`));
  const pay = link ? `You can pay with this Razorpay link from ${merchant} for ${exact(total(lines))}: ${link}` : `The bank details are on the invoice.`;
  return {
    body: `Hello ${firstNameOf(b.contact_name)},\n\nA quick note that ${items}.\n\n${pay}\n\n${signOff(merchant)}`,
    facts: factsFor(lines, now),
  };
}

export function gentle(b: Buyer, merchant: string, lines: Line[], link: string | null, now: number): Built {
  const items = and(lines.map((l) => `${itemDue(l)} was due on ${formatDate(l.due_date)}`));
  const pay = link ? `Pay link from ${merchant} for ${exact(total(lines))}: ${link}\nBank details are on the invoice.` : `Bank details are on the invoice.`;
  return {
    body: `Hello ${firstNameOf(b.contact_name)},\n\nA quick reminder that ${items}.\n\n${pay}\n\n${signOff(merchant)}`,
    facts: factsFor(lines, now),
  };
}

export function firm(b: Buyer, merchant: string, lines: Line[], now: number): Built {
  const items = and(lines.map((l) => `${itemDue(l)} is now ${Math.max(0, daysOverdue(l, now))} days overdue`));
  const all = lines.length > 1 ? ` That's ${exact(total(lines))} across ${lines.length} invoices.` : "";
  return {
    body: `Hello ${firstNameOf(b.contact_name)},\n\n${items[0].toUpperCase()}${items.slice(1)}.${all} Can you share a payment date this week?\n\n${signOff(merchant)}`,
    facts: factsFor(lines, now),
  };
}

// MSME rights (Udyam-registered merchants): the 45-day rule, interest at
// three times the RBI bank rate, and section 43B(h).
export function msme(b: Buyer, merchant: string, lines: Line[], now: number): Built {
  const items = and(
    lines.map((l) => `${itemDue(l)}, accepted on ${formatDate(l.accepted_at ?? l.due_date)}`),
  );
  return {
    body:
      `Hello ${firstNameOf(b.contact_name)},\n\n${merchant} is registered as a micro or small enterprise (Udyam). Under the MSMED Act, payment is due within ${MSME_DAYS} days of accepting the goods, and ${items} ${lines.length > 1 ? "are" : "is"} past that.\n\n` +
      `Past ${MSME_DAYS} days, interest applies at three times the RBI bank rate, and under section 43B(h) of the Income Tax Act an unpaid amount can't be claimed as an expense until it is paid.\n\n` +
      `Can you share a payment date for ${exact(total(lines))}?\n\n${signOff(merchant)}`,
    facts: factsFor(lines, now, { msme_days: String(MSME_DAYS), section: "43B(h)" }),
  };
}

export function callScript(b: Buyer, merchant: string, lines: Line[], owedTotal: number, now: number) {
  const oldest = [...lines].sort((x, y) => x.due_date - y.due_date)[0];
  const n = lines.length;
  return {
    opening: `Hi ${firstNameOf(b.contact_name)}, this is ${merchant} about ${exact(owedTotal)} overdue on ${n === 1 ? "one invoice" : `${n} invoices`}.`,
    lines: [
      `The oldest, ${oldest.number}, is ${Math.max(0, daysOverdue(oldest, now))} days overdue.`,
      "Can you share a date this week when it will be cleared?",
      "I'll send the details by email after this call so you can check them.",
    ],
    facts: { ...factsFor(lines, now), case_total_exact: exact(owedTotal), invoice_count: String(n) },
  };
}

// After a call: the details by email, so the buyer can check them.
export function callDetails(b: Buyer, merchant: string, lines: Line[], now: number): Built {
  const items = lines.map((l) => `${itemDue(l)}, ${Math.max(0, daysOverdue(l, now))} days overdue`);
  return {
    body: `Hello ${firstNameOf(b.contact_name)},\n\nHere are the details we called about:\n${items.map((x) => `- ${x}`).join("\n")}\n${lines.length > 1 ? `That's ${exact(total(lines))} in all.\n` : ""}\nBank details are on the invoice. Can you share a payment date?\n\n${signOff(merchant)}`,
    facts: factsFor(lines, now),
  };
}

export function promiseNoted(b: Buyer, merchant: string, lines: Line[], date: number, now: number): Built {
  return {
    body: `Thank you, ${firstNameOf(b.contact_name)}. We've noted ${exact(total(lines))} for ${and(lines.map((l) => l.number))} by ${formatDate(date)}.\n\n${merchant}`,
    facts: factsFor(lines, now, { promised_on: formatDate(date) }),
  };
}

export function askUtr(b: Buyer, merchant: string): Built {
  return {
    body: `Hello ${firstNameOf(b.contact_name)}, thank you for letting us know. We can't see this payment in our account yet. Could you share the UTR or transaction reference so we can match it?\n\n${merchant}`,
    facts: {},
  };
}

export function askTdsCertificate(b: Buyer, merchant: string, received: number, tds: { number: string; amount: number }[], rate: number, now: number): Built {
  const short = tds.reduce((n, t) => n + t.amount, 0);
  return {
    body: `Hello ${firstNameOf(b.contact_name)}, we received ${exact(received)} against ${and(tds.map((t) => t.number))}. Thank you. It's ${exact(short)} short, which looks like TDS at ${rate}%. Could you share the TDS certificate for it?\n\n${merchant}`,
    facts: { received_exact: exact(received), tds_exact: exact(short), tds_rate: String(rate), at: formatDate(now) },
  };
}

export function askRest(b: Buyer, merchant: string, received: number, rest: number): Built {
  return {
    body: `Hello ${firstNameOf(b.contact_name)}, thank you for the ${exact(received)}. ${exact(rest)} is still open. When can you clear the rest?\n\n${merchant}`,
    facts: { received_exact: exact(received), rest_exact: exact(rest) },
  };
}

export function documentCopy(b: Buyer, merchant: string, doc: string, lines: Line[]): Built {
  return {
    body: `Hello ${firstNameOf(b.contact_name)}, here is the ${doc} for ${and(lines.map(itemDue))}, attached.\n\n${merchant}`,
    facts: Object.fromEntries(lines.map((l) => [`owed_${l.number}`, exact(l.owed)])),
  };
}

export function correctedInvoice(b: Buyer, merchant: string, l: Line): Built {
  return {
    body: `Hello ${firstNameOf(b.contact_name)}, thank you for pointing that out. Here is the corrected invoice for ${l.number}, attached. The amount, ${exact(l.owed)}, is unchanged.\n\n${merchant}`,
    facts: { [`owed_${l.number}`]: exact(l.owed) },
  };
}

export function creditNote(b: Buyer, merchant: string, l: Line, disputed: number): Built {
  return {
    body: `Hello ${firstNameOf(b.contact_name)}, we've issued a credit note for ${exact(disputed)} against ${l.number}, attached. The balance of ${exact(l.owed)} is due.\n\n${merchant}`,
    facts: { disputed_exact: exact(disputed), [`owed_${l.number}`]: exact(l.owed) },
  };
}

export function splitPlan(b: Buyer, merchant: string, owed: number, parts: { amount: number; by: number }[]): Built {
  return {
    body: `Hello ${firstNameOf(b.contact_name)}, we can split ${exact(owed)} into ${parts.length} parts: ${and(parts.map((p) => `${exact(p.amount)} by ${formatDate(p.by)}`))}. Please reply to confirm.\n\n${merchant}`,
    facts: { owed_exact: exact(owed), parts: String(parts.length), ...Object.fromEntries(parts.map((p, i) => [`part_${i + 1}`, `${exact(p.amount)} by ${formatDate(p.by)}`])) },
  };
}

// ---- To the merchant (I, short, ₹ and the name first, one ask).

export const owes = (b: Pick<Buyer, "name">, owed: number, oldestDays: number) =>
  `${b.name} owes ${formatMoney(owed)}${oldestDays > 0 ? `, the oldest invoice ${oldestDays} days overdue` : ""}.`;
