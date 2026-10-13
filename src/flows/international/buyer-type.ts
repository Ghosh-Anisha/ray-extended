// Buyer type (B2C or B2B), by code: link vs invoice, amount, business email
// domain and the playbook. Each signal adds a point; the playbook's own
// answer counts double. A tie is left open (type null): the flow then uses
// B2C wording and, in D, offers both routes to the merchant. No model.

export type BuyerType = "b2b" | "b2c";
export type BuyerTypeResult = { type: BuyerType | null; b2b: number; b2c: number; reasons: string[] };

const CONSUMER_DOMAINS = [
  /^gmail\.com$/, /^googlemail\.com$/, /^yahoo\./, /^ymail\.com$/, /^hotmail\./, /^outlook\./, /^live\./, /^msn\.com$/,
  /^icloud\.com$/, /^me\.com$/, /^mac\.com$/, /^aol\.com$/, /^proton\.me$/, /^protonmail\.com$/, /^gmx\./, /^web\.de$/, /^mail\.com$/,
];
const ROLE_MAILBOX = /^(accounts?|billing|finance|payables|ap|procurement|purchasing|invoices?|admin)$/i;
// "inv" or "invoice" as its own token in a receipt or reference: pf_inv_2041, INV-112.
const INVOICE_REF = /(^|[_\-\s#/])inv(oice)?([_\-\s#/]|\d|$)/i;

export const B2B_AMOUNT_INR = 100_000 * 100; // ₹1 lakh and up
export const B2C_AMOUNT_INR = 10_000 * 100; // ₹10,000 and under

export function isInvoiceRef(ref: string | null | undefined) {
  return !!ref && INVOICE_REF.test(ref);
}

export function buyerType(input: {
  // The order or link's receipt / reference.
  reference: string | null;
  // Paid through a payment link or a checkout (not an invoice).
  viaLink: boolean;
  amountInr: number | null;
  email: string | null;
  merchantBusinessType: string;
  playbook: BuyerType | null;
}): BuyerTypeResult {
  let b2b = 0;
  let b2c = 0;
  const reasons: string[] = [];
  if (input.playbook) {
    if (input.playbook === "b2b") b2b += 2;
    else b2c += 2;
    reasons.push(input.playbook === "b2b" ? "Your playbook says your buyers abroad are businesses." : "Your playbook says your buyers abroad are people buying for themselves.");
  }
  if (isInvoiceRef(input.reference)) {
    b2b += 2;
    reasons.push("It was an invoice payment.");
  } else if (input.viaLink || input.reference) {
    b2c += 1;
    reasons.push(input.viaLink ? "It came through a payment link." : "It came through your checkout.");
  }
  if (input.amountInr !== null) {
    if (input.amountInr >= B2B_AMOUNT_INR) {
      b2b += 1;
      reasons.push("The amount is business-sized.");
    } else if (input.amountInr <= B2C_AMOUNT_INR) {
      b2c += 1;
      reasons.push("The amount is a personal purchase size.");
    }
  }
  const [local, domain] = (input.email ?? "").toLowerCase().split("@");
  if (domain) {
    if (CONSUMER_DOMAINS.some((d) => d.test(domain))) {
      b2c += 1;
      reasons.push("They used a personal email.");
    } else {
      b2b += 1;
      reasons.push(ROLE_MAILBOX.test(local) ? "They wrote from a company accounts mailbox." : "They used a company email domain.");
    }
  }
  if (/_b2b$/.test(input.merchantBusinessType)) b2b += 1;
  if (/_b2c$/.test(input.merchantBusinessType)) b2c += 1;
  return { type: b2b > b2c ? "b2b" : b2c > b2b ? "b2c" : null, b2b, b2c, reasons };
}
