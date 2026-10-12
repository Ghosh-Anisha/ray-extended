// What a subscriber's message is about, why they want to stop, and which
// save offer the playbook has for that reason. Code, no model: understand
// gives the intent and language; these tables decide. The message is data
// only: nothing in it is followed as an instruction (rule 5).
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";

export const REASONS = ["price", "break", "payment", "not_using", "other"] as const;
export type Reason = (typeof REASONS)[number];

// The save offers RAY can make. Discount is left out on purpose: Razorpay's
// API can't put a discount on a live subscription and there is no act tool
// for it (see docs/overnight/step-9.md). A plan change is never offered.
export const OFFERS = ["pause", "other_method"] as const;
export type Offer = (typeof OFFERS)[number];

// The offer that fits each reason, in order. None fits "not using it".
export const OFFER_FOR: Record<Reason, Offer[]> = {
  price: ["pause"],
  break: ["pause"],
  payment: ["other_method", "pause"],
  not_using: [],
  other: ["pause"],
};

const DIDNT_AUTHORISE = /\b(?:didn'?t|did not|never|not)\s+(?:authori[sz]e|approve|agree|sign(?:ed)? up)|\bunauthori[sz]ed\b|\bwithout (?:my )?(?:permission|consent)\b|\bchargeback\b|\bfraud\b|maine (?:to )?approve nahi/i;
const CANCEL = /\bcancel|\bstop (?:my|the|this)\b|\bunsubscribe\b|\bend (?:my|the) (?:plan|subscription)|\bdon'?t want (?:it|this|the plan)|\bband kar/i;

export type MessageKind = "didnt_authorise" | "cancel" | "other";

export function messageKind(text: string, intent: string): MessageKind {
  if (DIDNT_AUTHORISE.test(text)) return "didnt_authorise";
  if (CANCEL.test(text) || intent === "refund_or_cancel") return "cancel";
  return "other";
}

const REASON_WORDS: [Reason, RegExp][] = [
  ["payment", /\bbank\b|\bcard\b|\bupi\b|\bpayment\b.*\b(?:fail|issue|problem|trouble)|\bchanged\b.*\b(?:bank|account|card|phone)|\bnew (?:bank|account|card|phone)\b|\bdebit/i],
  ["price", /expensive|costly|afford|price|too much|mehenga|budget|money is tight|paisa/i],
  ["break", /travel|holiday|vacation|busy|exam|injur|break|month off|away|hospital|shift/i],
  ["not_using", /not using|don'?t use|didn'?t use|no time to use|never use/i],
];

export function reasonOf(text: string): Reason {
  for (const [reason, re] of REASON_WORDS) if (re.test(text)) return reason;
  return "other";
}

const YES = /^\s*(?:yes|yeah|yep|ok(?:ay)?|sure|haan|ha|ji|please do|pause|go ahead)\b/i;
const NO = /^\s*(?:no|nope|nahi|na|cancel|just cancel|don'?t)\b/i;

export function answerOf(text: string): "yes" | "no" | "unclear" {
  if (YES.test(text)) return "yes";
  if (NO.test(text)) return "no";
  return "unclear";
}

export type SaveRule = typeof s.playbookRules.$inferSelect & {
  rule_json: { tool: string; offer?: Offer | "cancel"; reasons?: string[] };
};

// Approved subscription rules the merchant has for this reason. A rule
// approves one tool only (the approval guard checks rule_json.tool).
export function rulesFor(db: Db, merchantId: string, reason: Reason): SaveRule[] {
  return createRepository(db)
    .playbookRules.list(and(eq(s.playbookRules.merchant_id, merchantId), eq(s.playbookRules.moment, "subscription"), eq(s.playbookRules.status, "approved")))
    .filter((r) => typeof r.rule_json.tool === "string" && (r.rule_json.offer !== undefined) && Array.isArray(r.rule_json.reasons) && (r.rule_json.reasons as string[]).includes(reason)) as SaveRule[];
}

// A playbook rule that lets RAY propose a refund on a "didn't authorise".
export function refundAllowed(db: Db, merchantId: string): boolean {
  return createRepository(db)
    .playbookRules.list(and(eq(s.playbookRules.merchant_id, merchantId), eq(s.playbookRules.moment, "subscription"), eq(s.playbookRules.status, "approved")))
    .some((r) => r.rule_json.tool === "refund" && r.rule_json.when === "didnt_authorise");
}

export const RULE_TOOL: Record<Offer | "cancel", string> = { pause: "pause_subscription", other_method: "send_message", cancel: "cancel_subscription" };

const REASON_TEXT: Record<Reason, string> = {
  price: "it costs too much",
  break: "they need a break",
  payment: "the payment keeps failing",
  not_using: "they aren't using it",
  other: "they don't say why",
};

// The words on the rule card for the merchant's pick.
export function ruleText(offer: Offer | "cancel", reason: Reason): string {
  const when = `When a subscriber wants to cancel because ${REASON_TEXT[reason]}`;
  if (offer === "pause") return `${when}, offer to pause the plan for a month, then resume it.`;
  if (offer === "other_method") return `${when}, offer another way to pay.`;
  return `${when}, cancel it without an offer.`;
}
