// Every line RAY writes in this moment, in the design language's voice
// (docs/design-language.md sections 1 and 2). Subscribers hear the merchant
// ("we", signed with the merchant's sign-off); merchants hear RAY ("I"), the
// name and ₹ first, one question. Numbers come only from the case data the
// grounding guard checks against: amounts, dates and times from records and
// timers. No em dashes, no internal words.
import { firstNameOf } from "@/adapters/voice";

export type SubBits = {
  name: string; // subscriber's first name, or the business name for B2B
  merchant: string;
  plan: string;
  amount: string; // ₹499
};

export const bitsFor = (customerName: string, merchant: string, plan: string, amount: string, b2b = false): SubBits => ({
  name: b2b ? customerName : firstNameOf(customerName),
  merchant,
  plan,
  amount,
});

// Why a debit failed, from the pending invoice's error_reason (code, no model).
export const B_VARIANTS = ["no_funds", "needs_pin", "card_expired", "unknown"] as const;
export type BVariant = (typeof B_VARIANTS)[number];

export function bVariant(errorReason: string | null | undefined): BVariant {
  const r = (errorReason ?? "").toLowerCase();
  if (/insufficient|balance|funds/.test(r)) return "no_funds";
  if (/pin|paused|limit|mandate (?:is )?(?:paused|revoked)|authori[sz]ation required/.test(r)) return "needs_pin";
  if (/card.*(expired|replaced|blocked|reissued)|expired card/.test(r)) return "card_expired";
  return "unknown";
}

const B_STEPS: Record<BVariant, string> = {
  no_funds: "It didn't go through because the account didn't have enough balance at the time.",
  needs_pin: "Your bank needs you to approve this one yourself, so it asks for your UPI PIN when you pay.",
  card_expired: "The card on file has expired or was replaced. Paying on the page below with your new card also updates it for next time.",
  unknown: "Your bank didn't let the payment through.",
};

// A: the sign-up never finished. One message with the subscription's own
// first invoice link, and why it stopped if Razorpay says.
export function finishSetupLine(b: SubBits, link: string, why: string | null, signOff: string) {
  return [
    `Hi ${b.name}, this is ${b.merchant}. Your ${b.plan} sign-up for ${b.amount} a month didn't finish${why ? `: ${why.replace(/\.$/, "")}` : ""}.`,
    `You can finish setting it up here: ${link}`,
    `The page shows ${b.merchant} and ${b.amount}, so you can check it before you pay.`,
    signOff,
  ].join("\n");
}

// B: retries ran out. The subscription's own pending invoice, never a fresh link.
export function pendingInvoiceLine(b: SubBits, variant: BVariant, link: string, signOff: string) {
  return [
    `Hi ${b.name}, this is ${b.merchant}. Your ${b.plan} payment of ${b.amount} didn't go through, so the plan is on hold.`,
    B_STEPS[variant],
    `You can pay this month's ${b.amount} here and the plan carries on: ${link}`,
    `The page shows ${b.merchant} and ${b.amount}, so you can check it before you pay.`,
    signOff,
  ].join("\n");
}

// F: B2B renewal failed. To the billing contact, with a bank-transfer option.
export function b2bInvoiceLine(b: SubBits, link: string, period: string, signOff: string) {
  return [
    `Hello ${b.name}, this is ${b.merchant}. The renewal payment of ${b.amount} for ${b.plan} (${period}) didn't go through on the card on file.`,
    `The invoice is here: ${link}`,
    `You can pay it there by card, UPI or bank transfer (NEFT or RTGS), whichever suits your accounts team. The invoice page shows ${b.merchant} and ${b.amount}.`,
    signOff,
  ].join("\n");
}

// C: the mandate was cancelled in the UPI app. Asks once why. No link.
export function whyCancelledLine(b: SubBits, signOff: string) {
  return [
    `Hi ${b.name}, this is ${b.merchant}. We saw the AutoPay for your ${b.plan} (${b.amount} a month) was cancelled in your UPI app.`,
    "Was that on purpose, or did something go wrong with the payment? Just reply here and we'll sort it out.",
    signOff,
  ].join("\n");
}

// C, payment trouble, nothing due yet: steps now, the link when it's due.
export function setupAgainLaterLine(b: SubBits, due: string, signOff: string) {
  return [
    `Thanks ${b.name}. Nothing is due right now, so your ${b.plan} carries on as it is.`,
    `When your next payment of ${b.amount} is due on ${due}, we'll send you a link to set up AutoPay again. Paying it sets it up for the months after.`,
    signOff,
  ].join("\n");
}

// C, payment trouble, a cycle is due: set up again with that invoice's link.
export function setupAgainLine(b: SubBits, link: string, signOff: string) {
  return [
    `Hi ${b.name}, this is ${b.merchant}. Your ${b.plan} payment of ${b.amount} is due.`,
    `Paying it here also sets up AutoPay again for the months after: ${link}`,
    `The page shows ${b.merchant} and ${b.amount}, so you can check it before you pay.`,
    signOff,
  ].join("\n");
}

// D: the one save offer.
export function pauseOfferLine(b: SubBits, skip: boolean, signOff: string) {
  return [
    `Hi ${b.name}, thanks for telling us.`,
    skip
      ? `Before you go: would skipping a month help? We'd pause your ${b.plan} for a month, with nothing to pay till it starts again.`
      : `Before you go: would a break help? We can pause your ${b.plan} for a month, with nothing to pay till it starts again.`,
    "Reply YES to pause, or NO and we'll cancel it.",
    signOff,
  ].join("\n");
}

export function discountOfferLine(b: SubBits, percent: string, signOff: string) {
  return [
    `Hi ${b.name}, thanks for telling us.`,
    `Before you go: we can take ${percent} off your next ${b.plan} payment, if that helps you stay.`,
    "Reply YES and we'll apply it, or NO and we'll cancel the plan.",
    signOff,
  ].join("\n");
}

export function discountAppliedLine(b: SubBits, percent: string, signOff: string) {
  return [`Done, ${b.name}. ${percent} comes off your next ${b.plan} payment. Thanks for staying with ${b.merchant}.`, signOff].join("\n");
}

export function otherMethodOfferLine(b: SubBits, signOff: string) {
  return [
    `Hi ${b.name}, thanks for telling us.`,
    `If it's the payment that's the trouble, we can set up your ${b.plan} on another way to pay instead, like a different UPI app or a card.`,
    "Reply YES and we'll send you the details, or NO and we'll cancel it.",
    signOff,
  ].join("\n");
}

export function pausedLine(b: SubBits, until: string, signOff: string) {
  return [`Done, ${b.name}. Your ${b.plan} is paused until ${until}. Nothing will be taken till then.`, signOff].join("\n");
}

export function cancelledLine(b: SubBits, signOff: string) {
  return [`Hi ${b.name}, your ${b.plan} is cancelled as you asked. Thanks for being with ${b.merchant}.`, signOff].join("\n");
}

// Before the merchant decides, so the subscriber isn't left waiting.
export function promiseLine(b: SubBits, by: string, signOff: string) {
  return [`Hi ${b.name}, this is ${b.merchant}. We've got your message about your ${b.plan}. You'll hear from us by ${by}.`, signOff].join("\n");
}

export function holdingLine(b: SubBits, by: string, signOff: string) {
  return [`Hi ${b.name}, this is ${b.merchant}. We're still on your ${b.plan} question. You'll hear from us by ${by}.`, signOff].join("\n");
}

// E: drafted for the merchant's tap. Proof the subscriber can check, no link.
export function didntAuthoriseLine(
  b: SubBits,
  proof: { approvedOn: string | null; ref: string | null; method: string; noticeOn: string | null; chargedOn: string },
  signOff: string,
) {
  const lines = [`Hi ${b.name}, this is ${b.merchant}. We understand the ${b.amount} ${b.plan} renewal on ${proof.chargedOn} surprised you.`];
  if (proof.approvedOn) lines.push(`Our records show the ${proof.method} AutoPay was approved on ${proof.approvedOn}${proof.ref ? ` (mandate reference ending ${proof.ref.slice(-4)})` : ""}. You can see it under AutoPay in your UPI app.`);
  if (proof.noticeOn) lines.push(`A notice that this payment was coming went to you on ${proof.noticeOn}.`);
  lines.push("If you'd still like to stop the plan, reply here and we'll cancel it. If you think something is wrong, tell us and we'll look again.");
  lines.push(signOff);
  return lines.join("\n");
}

// ---- To the merchant (alerts and the Your call panel)

export const alerts = {
  pending: (who: string, amount: string, plan: string) => `${who}'s ${amount} ${plan} payment didn't go through. Razorpay is retrying, and I'm watching it.`,
  halted: (who: string, amount: string, plan: string) => `${who}'s ${amount} ${plan} payment failed and Razorpay's retries ran out. The plan is on hold.`,
  setup: (who: string, amount: string, plan: string) => `${who} started a ${amount} ${plan} sign-up but didn't finish setting up AutoPay.`,
  tokenCancelled: (who: string, amount: string, plan: string) => `${who} cancelled the AutoPay for ${plan} (${amount} a month) in their UPI app.`,
  cancel: (who: string, plan: string) => `${who} wants to cancel ${plan}.`,
  didntAuthorise: (who: string, amount: string) => `${who} says they didn't authorise a ${amount} renewal.`,
  duplicate: (who: string, amount: string) => `${who} was charged ${amount} twice for the same month.`,
};

export const REASON_LABEL: Record<string, string> = {
  price: "it costs too much",
  break: "they need a break",
  payment: "of trouble with the payment",
  not_using: "they aren't using it",
  other: "they didn't say why",
};
