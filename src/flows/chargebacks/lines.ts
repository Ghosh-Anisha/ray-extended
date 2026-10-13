// The fixed lines for chargebacks, in the design language's voice. To the
// merchant RAY speaks as "I", amount and name first, one ask. To the
// customer it is the merchant ("we"), with checkable details and no link.
// Every number comes from the case data (rule 6); nothing says "refunded"
// or "confirmed" (only a confirmation may, after the action ran).
import { formatDate, formatMoney, formatTime } from "@/guards";
import { TYPE_LABEL, type DisputeType } from "./rules";

export const when = (at: number) => `${formatTime(at)} on ${formatDate(at)}`;

export type DisputeBits = {
  who: string; // "Meera Iyer"
  first: string; // "Meera"
  amount: string; // ₹6,900
  type: DisputeType;
  order: string | null; // #1198
  deadline: string; // 10:00 AM on 15 Oct
};

const about = (b: DisputeBits) => `${b.who}'s ${b.amount} chargeback (${TYPE_LABEL[b.type]})`;

export const alertLine = (b: DisputeBits) =>
  `${b.who} raised a chargeback for ${b.amount} (${TYPE_LABEL[b.type]}). I'm putting the reply together. It's due by ${b.deadline}.`;

export const threatAlert = "A customer mentioned a chargeback. RAY is checking the payment first.";

// The Ask card: what happened, how RAY knows, one question.
export function askLine(b: DisputeBits, reason: string, question: string) {
  return `${about(b)[0].toUpperCase()}${about(b).slice(1)}. ${reason} ${question}`;
}

export const fyiLine = (b: DisputeBits, lane: "contest" | "accept", until: number) =>
  lane === "contest"
    ? `Under your rule, I'm contesting ${about(b)}. Stop by ${formatTime(until)} if you'd rather I didn't.`
    : `Under your rule, I'm accepting ${about(b)}. Stop by ${formatTime(until)} if you'd rather I didn't.`;

export const urgentLine = (b: DisputeBits) =>
  `${about(b)[0].toUpperCase()}${about(b).slice(1)} is due by ${b.deadline}. I need your call before then.`;

export const lapseLine = (b: DisputeBits) =>
  `${about(b)[0].toUpperCase()}${about(b).slice(1)} is due by ${b.deadline}. The proof is weak, so I'm not sending a reply; it will lapse unless you contest it.`;

export const deadlineReplyLine = (b: DisputeBits) =>
  `${about(b)[0].toUpperCase()}${about(b).slice(1)} is due by ${b.deadline} and you haven't answered. The proof is strong, so under your rule I'm sending the reply.`;

// The urgent call to the merchant: opens with who is calling and why.
export function urgentCall(b: DisputeBits, merchant: string) {
  return {
    opening: `Hi, this is RAY calling for ${merchant} about ${b.who}'s ${b.amount} chargeback.`,
    lines: [
      `The reply is due by ${b.deadline}, and I still need your decision.`,
      "I'm sending the decision card to your WhatsApp now. Tap Contest or Accept there.",
    ],
  };
}

// Customer outreach (non-fraud only): a fix or refund offer and a
// withdraw request, as the merchant. Checkable details, no link.
export type OutreachBits = { first: string; amount: string; time: string; date: string; ref: string | null; order: string | null; item: string | null; merchant: string; signOff: string };

export function outreachLine(o: OutreachBits, type: DisputeType) {
  const ref = o.ref ? ` (${o.ref})` : "";
  const order = o.order ? ` for order ${o.order}` : "";
  const what =
    type === "not_received"
      ? "Your bank told us your order hasn't reached you. Our records show it was sent."
      : type === "not_as_described"
        ? "Your bank told us the order wasn't what you expected."
        : type === "cancelled"
          ? "Your bank told us you cancelled this order but were still charged."
          : "Your bank told us there's a problem with this payment.";
  return `Hi ${o.first}, this is ${o.merchant} about your payment of ${o.amount} at ${o.time} on ${o.date}${ref}${order}. ${what} If something's wrong, reply here and we'll fix it or give your money back. If it's sorted, please ask your bank to withdraw the dispute. ${o.signOff}`;
}

const payment = (o: OutreachBits) => `your payment of ${o.amount} at ${o.time} on ${o.date}${o.ref ? ` (${o.ref})` : ""}${o.order ? ` for order ${o.order}` : ""}`;

// The order never went out: the merchant accepts, the bank returns the money.
export const neverShippedLine = (o: OutreachBits) =>
  `Hi ${o.first}, this is ${o.merchant} about ${payment(o)}. We're sorry, your order didn't go out. Your bank is returning ${o.amount} to you, so there's nothing more you need to do. ${o.signOff}`;

// A real complaint, refund chosen: accepting the dispute returns the money.
export const refundByAcceptLine = (o: OutreachBits) =>
  `Hi ${o.first}, this is ${o.merchant} about ${payment(o)}. We're sorry about the problem with your order. We've told your bank to return ${o.amount} to you, so there's nothing more you need to do. ${o.signOff}`;

// A real complaint, replacement chosen: a new one, then a withdraw request.
export const replacementLine = (o: OutreachBits) =>
  `Hi ${o.first}, this is ${o.merchant} about ${payment(o)}. We're sorry about the problem with your ${o.item ?? "order"}. We're sending you a new one. Once it reaches you, please ask your bank to withdraw the dispute. ${o.signOff}`;

// The merchant's view of a reply.
export const replyLine = (first: string, text: string) => `${first} replied: "${text}"`;
export const complaintLine = (first: string, text: string, amount: string, item: string | null) =>
  `${first} replied with a problem with the order: "${text}". Refund ${amount}${item ? ` or send a new ${item}` : ""}?`;

export const patternLine = (count: number, what: string, atStake: number, fix: string) =>
  `${count} chargebacks in the last 30 days ${what}: ${formatMoney(atStake)} at stake. ${fix}`;
