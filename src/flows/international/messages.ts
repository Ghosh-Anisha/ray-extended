// Code-written fallbacks for every buyer email, used only when the write job
// has no answer (a replay miss or a draft that failed its checks). The model
// writes the real ones from the same facts. English, as the merchant ("we"),
// signed with the playbook's sign-off. Every recovery email carries the
// merchant, the amount and what it's for next to the link (rule 7), and a
// bank decline never suggests the same card.
import type { Cause } from "./errors";

export type EmailFacts = {
  merchant: string;
  buyer_first_name: string;
  amount: string; // "$49"
  for: string; // "order nn_pro_annual_881"
  card: string | null; // "card ending 4242"
  link: string | null;
  paypal: boolean;
  bank_details: Record<string, string> | null;
  reference: string | null;
  sign_off: string;
};

const BUYER_REASON: Record<Cause, string> = {
  card_not_international: "your card isn't turned on for payments abroad",
  card_not_online: "your card isn't turned on for online payments",
  three_ds_failed: "your bank's security check didn't go through",
  three_ds_timed_out: "your bank's security check timed out",
  bank_declined: "your bank declined the card",
  bank_declined_fraud: "your bank declined the card",
  above_limit: "it couldn't go through on our checkout",
  currency_off: "it couldn't go through on our checkout",
  network_off: "it couldn't go through on our checkout",
  billing_missing: "it couldn't go through on our checkout",
  international_off: "it couldn't go through on our checkout",
  risk_hold: "it couldn't be completed",
  left_checkout: "it wasn't finished",
};
export const buyerReason = (cause: Cause) => BUYER_REASON[cause];

function bankLines(d: Record<string, string>) {
  return Object.entries(d)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

export function recoveryEmail(cause: Cause, f: EmailFacts): string {
  const hi = `Hi ${f.buyer_first_name},`;
  const bye = f.sign_off;
  const paypal = f.paypal ? " You can also pay with PayPal on the same page." : "";
  if (cause === "left_checkout") {
    return [hi, `You started paying ${f.amount} to ${f.merchant} for ${f.for} but didn't finish. If you'd still like it, here's a fresh payment link from ${f.merchant} for ${f.amount}: ${f.link}`, bye].join("\n\n");
  }
  const head = `Your card payment of ${f.amount} to ${f.merchant} for ${f.for} didn't go through: ${BUYER_REASON[cause]}.`;
  switch (cause) {
    case "card_not_international":
    case "card_not_online":
      return [
        hi,
        head,
        `To fix it, open your bank's app and turn on ${cause === "card_not_international" ? "international" : "online"} payments for your ${f.card ?? "card"}. Then pay ${f.amount} to ${f.merchant} here: ${f.link}`,
        `Or use another card on the same page.${paypal}`,
        bye,
      ].join("\n\n");
    case "three_ds_failed":
    case "three_ds_timed_out":
      return [hi, head, `You can try again here, a fresh payment link from ${f.merchant} for ${f.amount}: ${f.link}${paypal}`, bye].join("\n\n");
    case "bank_declined":
    case "bank_declined_fraud":
      return [hi, head, `Please pay with a different card${f.paypal ? " or with PayPal" : ""} on this fresh payment link from ${f.merchant} for ${f.amount}: ${f.link}`, bye].join("\n\n");
    default:
      // D: another way to pay.
      if (f.bank_details) {
        return [
          hi,
          head,
          `You can pay ${f.amount} by bank transfer to ${f.merchant} instead:`,
          bankLines(f.bank_details),
          `Please put ${f.reference ?? f.for} as the reference.`,
          bye,
        ].join("\n\n");
      }
      return [hi, head, `You can pay ${f.amount} to ${f.merchant} with PayPal on this payment link: ${f.link}`, bye].join("\n\n");
  }
}

export function replyEmail(f: EmailFacts): string {
  const pay = f.link ? ` You can pay here, a payment link from ${f.merchant} for ${f.amount}: ${f.link}` : "";
  return [`Hi ${f.buyer_first_name},`, `Thanks for writing. We don't see a completed payment of ${f.amount} to ${f.merchant} for ${f.for} yet.${pay}`, f.sign_off].join("\n\n");
}
