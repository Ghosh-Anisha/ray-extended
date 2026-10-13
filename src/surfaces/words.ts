// The exact words from docs/design-language.md section 1, in one place so
// every surface says the same thing. Don't add synonyms here.
import type { CaseState, Moment } from "@/db/schema";
import type * as s from "@/db/schema";

export const MOMENT_LABEL: Record<Moment, string> = {
  paid_no_order: "Paid, no order",
  international: "Card declined abroad",
  subscription: "Subscription stopped",
  chargeback: "Chargeback",
  collect: "Invoice overdue",
  whose_side: "Is it me or Razorpay?",
  ticket: "Ticket black hole",
  settlement_hold: "Settlement held",
  ai_chat_order: "AI-chat order",
};

export type Tone = "neutral" | "information" | "notice" | "positive" | "negative";

export const STATE_LABEL: Record<CaseState, string> = {
  likely: "Likely: checking",
  confirmed: "Confirmed",
  waiting_merchant: "Needs you",
  waiting_customer: "Waiting for customer",
  acting: "Doing it",
  verifying: "Checking it worked",
  closed: "Resolved",
  fixed_itself: "Fixed itself",
  unconfirmed: "Closed, no reply",
};

// Chip colours: neutral, info, warning, success (design language names) in
// Blade's feedback colours.
export const STATE_TONE: Record<CaseState, Tone> = {
  likely: "neutral",
  confirmed: "information",
  waiting_merchant: "notice",
  waiting_customer: "neutral",
  acting: "information",
  verifying: "information",
  closed: "positive",
  fixed_itself: "neutral",
  unconfirmed: "neutral",
};

export const INBOX_TABS = [
  { key: "needs_you", label: "Needs you", states: ["waiting_merchant"] },
  { key: "handling", label: "RAY is handling", states: ["likely", "confirmed", "waiting_customer", "acting", "verifying"] },
  { key: "closed", label: "Closed", states: ["closed", "fixed_itself", "unconfirmed"] },
] as const satisfies readonly { key: string; label: string; states: readonly CaseState[] }[];
export type InboxTab = (typeof INBOX_TABS)[number]["key"];

export const tabFor = (state: CaseState): InboxTab => INBOX_TABS.find((t) => (t.states as readonly CaseState[]).includes(state))!.key;

export type Confidence = (typeof s.CONFIDENCES)[number];
export const CONFIDENCE_LABEL: Record<Confidence, string> = { sure: "Sure", likely: "Likely", unsure: "Unsure" };
export const CONFIDENCE_TONE: Record<Confidence, Tone> = { sure: "positive", likely: "information", unsure: "notice" };

export type Side = (typeof s.SIDES)[number];
export const SIDE_LABEL: Record<Side, string> = {
  razorpay: "Razorpay's side",
  merchant: "Your side",
  customer_or_bank: "Customer or bank",
};
export const SIDE_NOTE: Record<Side, string> = {
  razorpay: "The evidence points to Razorpay; this does not confirm compensation terms.",
  merchant: "Here's the fix.",
  customer_or_bank: "The available evidence does not always distinguish customer intent from a bank decision.",
};
export const RAZORPAY_PLUGIN_NOTE = "Razorpay's own plugin";

export const COVERED = "Covered";
export const YOUR_CALL = "Your call";
export const COVERED_HINT = "Prototype label only. Error-cover terms are proposed and not confirmed or guaranteed.";
export const YOUR_CALL_HINT = "This depends on your judgement.";

// What the merchant reads for a case's cause (the flows keep short keys).
const CAUSE_LABEL: Record<string, string> = {
  plugin_dropped_capture: "Razorpay's plugin dropped the payment update",
  site_down: "Your site was down when the payment came in",
  webhook_disabled: "Payment updates are turned off in your store",
  wrong_settings: "Your store's payment settings don't match Razorpay's",
  auto_cancelled: "The store cancelled the order before the payment arrived",
  order_missing: "The payment has no order in your store",
  not_captured: "The payment was authorised but not captured",
  paid_twice: "Charged twice",
  duplicate_charge: "Charged twice",
  duplicate: "Charged twice, and the bank was told",
  not_received: "The customer says it never arrived",
  no_matching_payment: "No payment matches what the customer says",
  above_international_limit: "Above your limit for international payments",
  international_declined: "The card was declined abroad",
  retries_ran_out: "Razorpay's retries ran out",
  cancel_request: "The customer asked to cancel",
  invoice_overdue: "The invoice is past its due date",
  dispute: "The customer disputed the payment with their bank",
  success_rate_drop: "Success rate dropped for one payment method",
  ticket_sla: "A support ticket missed its next update",
  settlement_review: "A settlement is held for review",
  ai_chat_drift: "The chat intent, order and payment do not match",
};
export const causeLabel = (cause: string) => CAUSE_LABEL[cause] ?? cause.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export const SIMULATED = "Simulated";
export const KILL_SWITCH_BANNER = "RAY's actions are paused for this account. Reading still works.";
export const DOING_IT = "Doing it…";
export const SOMETHING_ELSE = "Something else";
export const OPEN_CASE = "Open case";
export const APPROVE = "Approve";
export const CHANGE = "Change";
export const LET_RAY_FIX = "Let RAY fix these";
// Same words as the orchestrator's HANDLE_MYSELF_LABEL.
export const HANDLE_MYSELF = "I'll handle this myself";

export const FINDING_SOURCES = ["Razorpay", "Store", "Customer", "Bank", "Simulated"] as const;
export type FindingSource = (typeof FINDING_SOURCES)[number];

export const SENDER_MODE_LABEL: Record<(typeof s.SENDER_MODES)[number], (merchant: string) => string> = {
  merchant_inbox: (m) => `${m}'s own number or inbox`,
  verified_domain: (m) => `${m}'s verified email domain`,
  via_razorpay: (m) => `${m} via Razorpay`,
};

export const EMPTY = {
  needs_you: "No cases need you. RAY will show paid orders that didn't update here.",
  handling: "RAY isn't working on anything right now. Cases it is checking or following up show here.",
  closed: "No closed cases yet. Resolved cases and ones that fixed themselves show here.",
  alerts: "No alerts. When a payment goes wrong, you'll see it here with the likely cause, RAY on or not.",
  findings: "RAY hasn't found anything yet. Findings show here as RAY checks Razorpay, your store and the customer's messages.",
  conversation: "No messages on this case yet. Messages with the customer show here.",
  digest: "Nothing needs you right now. The digest lists cases that need your tap.",
  cards: "No cards. When a case needs your tap, RAY sends a card here.",
  calls: "No calls yet. Calls RAY places for a case show here with the transcript and outcome.",
};

export const TONES = ["Warm", "Friendly", "Formal"] as const;
export type ToneSetting = (typeof TONES)[number];

// How refunds go by default; "Make it instant" on the card overrides it.
export type RefundSpeedSetting = "normal" | "optimum";
export const REFUND_SPEED_LABEL: Record<RefundSpeedSetting, string> = { normal: "Normal (5 to 7 working days)", optimum: "Instant where the bank allows" };
