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
  customer_or_bank: "Customer's bank",
};
export const SIDE_NOTE: Record<Side, string> = {
  razorpay: "Free. Razorpay owns this.",
  merchant: "Here's the fix.",
  customer_or_bank: "RAY will handle the customer.",
};
export const RAZORPAY_PLUGIN_NOTE = "Razorpay's own plugin";

export const COVERED = "Covered";
export const YOUR_CALL = "Your call";
export const COVERED_HINT = "If RAY gets this wrong, the proposed error cover applies.";
export const YOUR_CALL_HINT = "This depends on your judgement.";

export const SIMULATED = "Simulated";
// Under an action button: the follow-ups the same tap covers.
export const ALSO_COVERS = "The same tap also covers:";
export const KILL_SWITCH_BANNER = "RAY's actions are paused for this account. Reading still works.";
export const DOING_IT = "Doing it…";
export const SOMETHING_ELSE = "Something else";
export const OPEN_CASE = "Open case";
export const APPROVE = "Approve";
export const CHANGE = "Change";
export const LET_RAY_FIX = "Let RAY fix these";
// Same words as the orchestrator's HANDLE_MYSELF_LABEL.
export const HANDLE_MYSELF = "I'll handle this myself";

export const FINDING_SOURCES = ["Razorpay", "Store", "Customer", "Bank"] as const;
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
