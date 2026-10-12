// Recording only, never used at runtime. The write job's answers for this
// flow, written in Claude Code acting as the model: buyer emails, the D
// request reason and the insight text. Run the scenario tests with
// RAY_AI_BOOK pointing here and RAY_AI_CAPTURE_DIR at a scratch folder; then
// `npx tsx src/flows/international/record-fixtures.ts <dir>` turns what was
// captured into fixtures labelled "recorded in Claude Code".
import type { ModelClient } from "@/ai/client";

type Facts = Record<string, unknown>;
type WriteIn = { audience: string; kind: string; facts: Facts; language: string };

const str = (v: unknown) => (typeof v === "string" ? v : "");

function bankBlock(f: Facts) {
  const d = (f.bank_details ?? {}) as Record<string, string>;
  return Object.entries(d)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

function french(kind: string, f: Facts): string | null {
  if (!kind.startsWith("buyer_recovery_bank_declined")) return null;
  return [
    `Bonjour ${str(f.buyer_first_name)},`,
    `Votre paiement par carte de ${str(f.amount)} à ${str(f.merchant)} (${str(f.for)}) n'a pas abouti : votre banque a refusé la carte.`,
    `Vous pouvez payer avec une autre carte${f.paypal ? " ou avec PayPal" : ""} sur ce nouveau lien de paiement de ${str(f.merchant)} pour ${str(f.amount)} : ${str(f.link)}`,
    str(f.sign_off),
  ].join("\n\n");
}

function buyerEmail(kind: string, f: Facts): string {
  const hi = `Hi ${str(f.buyer_first_name)},`;
  const bye = str(f.sign_off);
  const m = str(f.merchant);
  const amt = str(f.amount);
  const what = str(f.for);
  const link = str(f.link);
  const paypal = f.paypal ? " If it's easier, you can pay with PayPal on the same page." : "";
  if (kind === "buyer_reply") {
    return [hi, `Thanks for your message. We've checked, and we haven't received your payment of ${amt} to ${m} for ${what} yet.${link ? ` You can still pay ${amt} on our payment link: ${link}` : ""}`, bye].join("\n\n");
  }
  if (kind.endsWith("_bank")) {
    return [
      hi,
      `Your card payment of ${amt} to ${m} for ${what} couldn't go through on our checkout, so here is another way to pay.`,
      `You can send ${amt} by bank transfer to ${m}:`,
      bankBlock(f),
      `Please use ${str(f.reference) || what} as the payment reference so we can match it to you.`,
      bye,
    ].join("\n\n");
  }
  const cause = kind.replace("buyer_recovery_", "");
  switch (cause) {
    case "card_not_international":
    case "card_not_online":
      return [
        hi,
        `Your payment of ${amt} to ${m} for ${what} didn't go through because ${str(f.what_happened)}.`,
        `It's a quick fix: in your bank's app, turn on ${cause === "card_not_international" ? "international" : "online"} payments for your ${str(f.card) || "card"}, then use this fresh payment link from ${m} for ${amt}: ${link}`,
        `You can also use another card on the same link.${paypal}`,
        bye,
      ].join("\n\n");
    case "three_ds_failed":
    case "three_ds_timed_out":
      return [hi, `Your payment of ${amt} to ${m} for ${what} didn't finish because ${str(f.what_happened)}.`, `You can try again on this fresh payment link from ${m} for ${amt}: ${link}${paypal}`, bye].join("\n\n");
    case "bank_declined":
    case "bank_declined_fraud":
      return [
        hi,
        `Your payment of ${amt} to ${m} for ${what} didn't go through: your bank declined the card.`,
        `Please pay with a different card${f.paypal ? " or with PayPal" : ""} on this fresh payment link from ${m} for ${amt}: ${link}`,
        bye,
      ].join("\n\n");
    case "left_checkout":
      return [hi, `It looks like your payment of ${amt} to ${m} for ${what} wasn't finished.`, `If you'd still like it, here's a fresh payment link from ${m} for ${amt}: ${link}`, bye].join("\n\n");
    default:
      return [hi, `Your card payment of ${amt} to ${m} for ${what} couldn't go through on our checkout. You can pay with PayPal on this payment link from ${m} for ${amt}: ${link}`, bye].join("\n\n");
  }
}

function requestReason(f: Facts): string {
  const business = f.buyer_type === "b2b" ? ", a business customer," : "";
  return `${str(f.buyer)}${business} tried to pay ${str(f.amount)} for ${str(f.for)} by card, and Razorpay declined it. ${str(f.what_happened)} Please ${str(f.ask)} on ${str(f.merchant)}'s account, so this payment and others like it can go through.`;
}

function insight(f: Facts): string {
  const change = f.setting_change ? ` ${str(f.setting_change)}? ${str(f.trade_off)}` : "";
  return `${String(f.failures)} buyers abroad couldn't pay you in the last ${String(f.days)} days for the same reason: ${str(f.what_they_share)}. That's ${str(f.at_stake)} at stake.${change}`;
}

const book: ModelClient = {
  async complete({ input }) {
    const w = input as WriteIn;
    if (!w || typeof w.kind !== "string") throw new Error("The international book only answers the write job");
    if (w.kind === "request_reason") return { draft: requestReason(w.facts), confidence: "sure" };
    if (w.kind === "intl_insight") return { draft: insight(w.facts), confidence: "sure" };
    if (w.audience === "buyer") {
      const fr = w.language === "fr" ? french(w.kind, w.facts) : null;
      return { draft: fr ?? buyerEmail(w.kind, w.facts), confidence: "sure" };
    }
    return { draft: null, confidence: "unsure" };
  },
};
export default book;
