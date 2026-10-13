// Every table from docs/build-guide.html, "Data model".
// Conventions: money is integer minor units (paise, cents, pence) with a
// currency column where it can be non-INR; times are epoch ms.
import { integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const MOMENTS = ["paid_no_order", "international", "subscription", "chargeback", "collect"] as const;
export const SITUATIONS = ["A", "B", "C", "D", "E", "F"] as const;
export const CASE_STATES = [
  "likely",
  "confirmed",
  "waiting_merchant",
  "waiting_customer",
  "acting",
  "verifying",
  "closed",
  "fixed_itself",
  "unconfirmed",
] as const;
export const CONFIDENCES = ["sure", "likely", "unsure"] as const;
export const SIDES = ["razorpay", "merchant", "customer_or_bank"] as const;
export const CASE_EVENT_TYPES = [
  "webhook",
  "message_in",
  "message_out",
  "tool_call",
  "approval",
  "timer",
  "finding",
  "note",
] as const;
// cancelled: a held action that never ran, e.g. when the merchant takes over.
export const ACTION_STATUSES = ["held", "done", "undone", "failed", "cancelled"] as const;
// Channels RAY writes on (send_message). Messages also carry voice notes
// (in, over WhatsApp) and calls; consents also cover calls (Step 5b).
export const CHANNELS = ["whatsapp", "email"] as const;
export const MESSAGE_CHANNELS = [...CHANNELS, "voice_note", "call"] as const;
export const CONSENT_CHANNELS = [...CHANNELS, "call"] as const;
export const CALL_OUTCOMES = ["answered", "no_answer", "busy", "asked_not_to_call"] as const;
export const DIRECTIONS = ["in", "out"] as const;
export const SENDER_MODES = ["merchant_inbox", "verified_domain", "via_razorpay"] as const;
export const RULE_SOURCES = ["edit", "merchant", "pattern"] as const;
export const RULE_STATUSES = ["proposed", "approved", "off"] as const;
export const MEMORY_KINDS = ["case", "edit", "rule", "pattern"] as const;
export const AI_MODES = ["replay", "live"] as const;
export const STORE_ORDER_STATUSES = ["pending", "processing", "cancelled", "completed"] as const;
export const SUBSCRIPTION_STATUSES = [
  "created",
  "authenticated",
  "active",
  "pending",
  "halted",
  "cancelled",
  "paused",
] as const;
export const DISPUTE_PHASES = ["chargeback", "pre_arbitration", "arbitration"] as const;
export const DISPUTE_DRAFT_STATUSES = ["draft", "submitted"] as const;
export const STORE_FAILURE_MODES = ["none", "dropped_200", "site_down", "webhook_disabled", "wrong_settings"] as const;
export const SITE_STATUSES = ["up", "down"] as const;
export const CONSENT_STATUSES = ["opted_in", "opted_out"] as const;
// Why an inbound event has no case. no_flow: no detector picked it up.
export const UNMATCHED_REASONS = ["no_flow"] as const;

export type Moment = (typeof MOMENTS)[number];
export type CaseState = (typeof CASE_STATES)[number];
export type CaseEventType = (typeof CASE_EVENT_TYPES)[number];

const id = () => text("id").primaryKey();
const bool = (name: string) => integer(name, { mode: "boolean" });
const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();

// Shared tables

export const merchants = sqliteTable("merchants", {
  id: id(),
  name: text("name").notNull(),
  business_type: text("business_type").notNull(),
  store_platform: text("store_platform").notNull(),
  gmv_band: text("gmv_band").notNull(),
  risk_band: text("risk_band").notNull(),
  failure_history: text("failure_history").notNull(),
  cluster: text("cluster").notNull(),
  wave: integer("wave").notNull(),
  ray_on: bool("ray_on").notNull(),
  connector_on: bool("connector_on").notNull(),
  whatsapp_on: bool("whatsapp_on").notNull(),
  banking_plus: bool("banking_plus").notNull(),
  udyam: bool("udyam").notNull(),
  approval_limit: integer("approval_limit").notNull(),
  kill_switch: bool("kill_switch").notNull().default(false),
  // Playbook: calls only between these times, minutes after midnight IST
  // (default 10 AM to 7 PM), and the opt-in for the urgent call the day
  // before a chargeback deadline (migration 0008).
  calling_hours_start: integer("calling_hours_start").notNull().default(600),
  calling_hours_end: integer("calling_hours_end").notNull().default(1140),
  urgent_call_opt_in: bool("urgent_call_opt_in").notNull().default(false),
  // Subscriptions playbook (migration 0900): a pause lasts this many days
  // before RAY resumes it (null: 30), and the discount save offer: an offer
  // made in the Razorpay Dashboard and its percent off (null: none).
  sub_pause_days: integer("sub_pause_days"),
  sub_discount_offer_id: text("sub_discount_offer_id"),
  sub_discount_percent: integer("sub_discount_percent"),
});

// One row, id "global" (migration 0007). The global kill switch: when on,
// every act tool is blocked for every merchant; reads still work. No row
// means off.
export const globalSettings = sqliteTable("global_settings", {
  id: id(),
  kill_switch: bool("kill_switch").notNull().default(false),
  updated_at: integer("updated_at").notNull(),
});

export const customers = sqliteTable("customers", {
  id: id(),
  merchant_id: text("merchant_id").notNull().references(() => merchants.id),
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone"),
  language: text("language").notNull().default("en"),
  country: text("country").notNull().default("IN"),
});

export const cases = sqliteTable("cases", {
  id: id(),
  merchant_id: text("merchant_id").notNull().references(() => merchants.id),
  moment: text("moment", { enum: MOMENTS }).notNull(),
  situation: text("situation", { enum: SITUATIONS }),
  state: text("state", { enum: CASE_STATES }).notNull(),
  confidence: text("confidence", { enum: CONFIDENCES }).notNull(),
  side: text("side", { enum: SIDES }),
  razorpay_plugin: bool("razorpay_plugin").notNull().default(false),
  covered: bool("covered").notNull().default(false),
  amount: integer("amount"),
  payment_id: text("payment_id"),
  store_order_id: text("store_order_id"),
  cause: text("cause"),
  promised_by: integer("promised_by"),
  opened_at: integer("opened_at").notNull(),
  closed_at: integer("closed_at"),
  outcome: text("outcome"),
  counts_as_saved: bool("counts_as_saved").notNull().default(false),
});

// Append only: no update or delete path in the repository, and triggers in
// migration 0001 reject UPDATE and DELETE at the database level.
// seq (migration 0003) is the insert order: set by the repository on insert
// as max + 1, unique, and checked by a trigger. listByCase orders by `at`
// then seq, so events at the same timestamp keep insert order.
export const caseEvents = sqliteTable("case_events", {
  id: id(),
  seq: integer("seq").unique(),
  case_id: text("case_id").notNull().references(() => cases.id),
  at: integer("at").notNull(), // when it happened at the source (webhook time, store history time), else clock.now()
  type: text("type", { enum: CASE_EVENT_TYPES }).notNull(),
  payload: json<Record<string, unknown>>("payload").notNull(),
  evidence_ref: text("evidence_ref"),
});

export const actions = sqliteTable("actions", {
  id: id(),
  case_id: text("case_id").notNull().references(() => cases.id),
  tool: text("tool").notNull(),
  args: json<Record<string, unknown>>("args").notNull(),
  guard_result: json<Record<string, unknown>>("guard_result"),
  approved_by: text("approved_by"), // "tap" or a playbook rule id
  idempotency_key: text("idempotency_key").notNull().unique(),
  status: text("status", { enum: ACTION_STATUSES }).notNull(),
  result: json<Record<string, unknown>>("result"),
  run_after: integer("run_after"),
});

export const timers = sqliteTable("timers", {
  id: id(),
  case_id: text("case_id").notNull().references(() => cases.id),
  kind: text("kind").notNull(),
  due_at: integer("due_at").notNull(),
  fired_at: integer("fired_at"),
  // Set when the timer is called off before it fires (migration 0006).
  cancelled_at: integer("cancelled_at"),
});

export const messages = sqliteTable("messages", {
  id: id(),
  case_id: text("case_id").references(() => cases.id),
  channel: text("channel", { enum: MESSAGE_CHANNELS }).notNull(),
  direction: text("direction", { enum: DIRECTIONS }).notNull(),
  from: text("from").notNull(),
  to: text("to").notNull(),
  sender_mode: text("sender_mode", { enum: SENDER_MODES }),
  body: text("body").notNull(),
  template_id: text("template_id"),
  within_24h: bool("within_24h"),
  at: integer("at").notNull(),
  // Inbound only, set by the engine (migration 0005).
  handled_case_id: text("handled_case_id"),
  unmatched_reason: text("unmatched_reason", { enum: UNMATCHED_REASONS }),
  // Voice notes and calls (migration 0008): what was said, the audio if
  // there is any (an id under /api/voice/audio) and how long it ran.
  transcript: text("transcript"),
  audio_ref: text("audio_ref"),
  duration_s: integer("duration_s"),
});

// One row per customer and channel (migration 0002). An opt-out blocks every
// proactive message on that channel. Buyers have rows too (migration 1100):
// a row names exactly one of customer_id or buyer_id, and a buyer needs an
// opted_in row for every message on that channel.
export const messagingConsents = sqliteTable(
  "messaging_consents",
  {
    id: id(),
    customer_id: text("customer_id").references(() => customers.id),
    buyer_id: text("buyer_id").references(() => buyers.id),
    // A buyer's WhatsApp or call consent is for this number (migration
    // 1101); a new number needs its own opt-in. Null: not tied to an address.
    address: text("address"),
    channel: text("channel", { enum: CONSENT_CHANNELS }).notNull(),
    status: text("status", { enum: CONSENT_STATUSES }).notNull(),
    source: text("source").notNull(),
    updated_at: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("messaging_consents_customer_channel").on(t.customer_id, t.channel),
    uniqueIndex("messaging_consents_buyer_channel").on(t.buyer_id, t.channel),
  ],
);

export const playbookRules = sqliteTable("playbook_rules", {
  id: id(),
  merchant_id: text("merchant_id").notNull().references(() => merchants.id),
  moment: text("moment", { enum: MOMENTS }).notNull(),
  rule_json: json<Record<string, unknown>>("rule_json").notNull(),
  text: text("text").notNull(),
  source: text("source", { enum: RULE_SOURCES }).notNull(),
  status: text("status", { enum: RULE_STATUSES }).notNull(),
  approved_at: integer("approved_at"),
});

export const memory = sqliteTable("memory", {
  id: id(),
  kind: text("kind", { enum: MEMORY_KINDS }).notNull(),
  text: text("text").notNull(),
  vector: json<Record<string, number>>("vector").notNull(),
  merchant_id: text("merchant_id").references(() => merchants.id), // null when pooled
});

export const aiCalls = sqliteTable("ai_calls", {
  id: id(),
  case_id: text("case_id").references(() => cases.id),
  job: text("job").notNull(),
  mode: text("mode", { enum: AI_MODES }).notNull(),
  model: text("model"),
  input_hash: text("input_hash").notNull(),
  output: json<unknown>("output"),
  valid: bool("valid").notNull(),
  ms: integer("ms").notNull(),
});

export const alerts = sqliteTable("alerts", {
  id: id(),
  merchant_id: text("merchant_id").notNull().references(() => merchants.id),
  case_id: text("case_id").references(() => cases.id),
  kind: text("kind").notNull(),
  text: text("text").notNull(),
  channel: text("channel").notNull(),
  sent_at: integer("sent_at").notNull(),
});

// Mirrors of Razorpay records (test mode or mock)

const rzpRecord = {
  status: text("status").notNull(),
  amount: integer("amount").notNull(),
  currency: text("currency").notNull().default("INR"),
  method: text("method"),
  contact: text("contact"),
  email: text("email"),
  vpa: text("vpa"),
  card_last4: text("card_last4"),
  card_country: text("card_country"),
  utr: text("utr"),
  error_code: text("error_code"),
  error_source: text("error_source"),
  error_reason: text("error_reason"),
  receipt: text("receipt"),
  created_at: integer("created_at").notNull(),
  captured_at: integer("captured_at"),
};

export const rzpOrders = sqliteTable("rzp_orders", {
  id: id(),
  merchant_id: text("merchant_id").notNull().references(() => merchants.id),
  ...rzpRecord,
});

export const rzpPayments = sqliteTable("rzp_payments", {
  id: id(),
  merchant_id: text("merchant_id").notNull().references(() => merchants.id),
  order_id: text("order_id").references(() => rzpOrders.id),
  ...rzpRecord,
  base_amount: integer("base_amount"), // INR paise, as Razorpay reports for foreign currency
});

export const rzpRefunds = sqliteTable("rzp_refunds", {
  id: id(),
  merchant_id: text("merchant_id").notNull().references(() => merchants.id),
  payment_id: text("payment_id").notNull().references(() => rzpPayments.id),
  ...rzpRecord,
});

export const rzpLinks = sqliteTable("rzp_links", {
  id: id(),
  merchant_id: text("merchant_id").notNull().references(() => merchants.id),
  payment_id: text("payment_id").references(() => rzpPayments.id),
  short_url: text("short_url"),
  ...rzpRecord,
});

// Simulated store and webhook systems

export type StoreItem = { name: string; qty: number; price: number; stock: number };
export type StatusChange = { status: string; at: number; note?: string };

export const storeOrders = sqliteTable("store_orders", {
  id: id(),
  number: text("number").notNull(),
  merchant_id: text("merchant_id").notNull().references(() => merchants.id),
  customer_id: text("customer_id").references(() => customers.id),
  status: text("status", { enum: STORE_ORDER_STATUSES }).notNull(),
  status_history: json<StatusChange[]>("status_history").notNull(),
  razorpay_order_id: text("razorpay_order_id"),
  receipt: text("receipt"),
  payment_id: text("payment_id"),
  total: integer("total").notNull(),
  items: json<StoreItem[]>("items").notNull(),
  stock: integer("stock"),
  created_at: integer("created_at").notNull(),
});

export const webhookDeliveries = sqliteTable("webhook_deliveries", {
  event_id: text("event_id").primaryKey(),
  merchant_id: text("merchant_id").notNull().references(() => merchants.id),
  event: text("event").notNull(),
  url: text("url").notNull(),
  http_status: integer("http_status"),
  response_body: text("response_body"),
  delivered_at: integer("delivered_at").notNull(),
  plugin: text("plugin"),
  plugin_version: text("plugin_version"),
  processed: bool("processed").notNull(),
  cron_note: text("cron_note"),
  payment_id: text("payment_id"),
  // Set by the engine (migration 0005): the case that took the event, or why
  // none did.
  handled_case_id: text("handled_case_id"),
  unmatched_reason: text("unmatched_reason", { enum: UNMATCHED_REASONS }),
});

// Simulated store state per merchant (migration 0002). The mock store reads
// its plugin failure from here so it survives a restart.
export const storeSettings = sqliteTable("store_settings", {
  merchant_id: text("merchant_id").primaryKey().references(() => merchants.id),
  webhook_enabled: bool("webhook_enabled").notNull(),
  site_status: text("site_status", { enum: SITE_STATUSES }).notNull(),
  plugin: text("plugin").notNull(),
  plugin_version: text("plugin_version").notNull(),
  failure_mode: text("failure_mode", { enum: STORE_FAILURE_MODES }).notNull(),
  // The store also takes payments through another gateway (migration 0009).
  // When a customer's payment matches nothing at Razorpay, RAY says it's
  // likely that gateway's.
  other_gateway: bool("other_gateway").notNull().default(false),
});

// Live stock per product. store_orders.items keeps a snapshot; stock is read here.
export const products = sqliteTable(
  "products",
  {
    id: id(),
    merchant_id: text("merchant_id").notNull().references(() => merchants.id),
    sku: text("sku").notNull(),
    name: text("name").notNull(),
    price: integer("price").notNull(),
    stock: integer("stock").notNull(),
  },
  (t) => [uniqueIndex("products_merchant_sku").on(t.merchant_id, t.sku)],
);

export const pluginReports = sqliteTable("plugin_reports", {
  id: id(),
  merchant_id: text("merchant_id").references(() => merchants.id),
  plugin: text("plugin").notNull(),
  plugin_version: text("plugin_version").notNull(),
  failure: text("failure").notNull(),
  reported_at: integer("reported_at").notNull(),
});

export const downtimes = sqliteTable("downtimes", {
  id: id(),
  method: text("method").notNull(),
  bank: text("bank"),
  start: integer("start").notNull(),
  end: integer("end"),
});

// Subscriptions

export const subscriptions = sqliteTable("subscriptions", {
  id: id(),
  merchant_id: text("merchant_id").notNull().references(() => merchants.id),
  customer_id: text("customer_id").notNull().references(() => customers.id),
  status: text("status", { enum: SUBSCRIPTION_STATUSES }).notNull(),
  plan: text("plan").notNull(),
  amount: integer("amount").notNull(),
  retries_left: integer("retries_left").notNull(),
  pending_invoice_id: text("pending_invoice_id"),
  b2b: bool("b2b").notNull(),
  lifetime_value: integer("lifetime_value").notNull(),
  resume_at: integer("resume_at"),
  started_at: integer("started_at").notNull(),
  // The offer linked to it (migration 0900, apply_offer).
  offer_id: text("offer_id"),
});

export const mandates = sqliteTable("mandates", {
  id: id(),
  subscription_id: text("subscription_id").notNull().references(() => subscriptions.id),
  method: text("method").notNull(),
  token_id: text("token_id"),
  status: text("status").notNull(),
  max_amount: integer("max_amount").notNull(),
  expires_at: integer("expires_at"),
  // When the subscriber approved the mandate, and its reference (migration 0900).
  authorised_at: integer("authorised_at"),
  auth_ref: text("auth_ref"),
});

export const subInvoices = sqliteTable("sub_invoices", {
  id: id(),
  subscription_id: text("subscription_id").notNull().references(() => subscriptions.id),
  amount: integer("amount").notNull(),
  status: text("status").notNull(),
  attempts: integer("attempts").notNull(),
  payment_id: text("payment_id"),
  error_reason: text("error_reason"),
  billing_start: integer("billing_start").notNull(),
  billing_end: integer("billing_end").notNull(),
  // When Razorpay sent the pre-debit notice for this cycle (migration 0900).
  notified_at: integer("notified_at"),
});

// Chargebacks

export const disputes = sqliteTable("disputes", {
  id: id(),
  merchant_id: text("merchant_id").notNull().references(() => merchants.id),
  payment_id: text("payment_id").notNull().references(() => rzpPayments.id),
  reason_code: text("reason_code").notNull(),
  reason: text("reason").notNull(),
  network: text("network").notNull(),
  phase: text("phase", { enum: DISPUTE_PHASES }).notNull(),
  amount: integer("amount").notNull(),
  deducted: bool("deducted").notNull(),
  respond_by: integer("respond_by").notNull(),
  status: text("status").notNull(),
  lane: text("lane"),
  created_at: integer("created_at").notNull(),
  // Contest evidence saved with action draft, then submitted (migration 0002).
  draft_json: json<Record<string, unknown>>("draft_json"),
  draft_status: text("draft_status", { enum: DISPUTE_DRAFT_STATUSES }),
});

// B2B invoice collection

export const buyers = sqliteTable("buyers", {
  id: id(),
  merchant_id: text("merchant_id").notNull().references(() => merchants.id),
  name: text("name").notNull(),
  contact_name: text("contact_name").notNull(),
  email: text("email"),
  phone: text("phone"),
  avg_days_late: integer("avg_days_late").notNull(),
  pay_history: text("pay_history").notNull(),
  usual_tds_rate: real("usual_tds_rate").notNull(), // percent
  key_account: bool("key_account").notNull(),
});

export const invoices = sqliteTable("invoices", {
  id: id(),
  merchant_id: text("merchant_id").notNull().references(() => merchants.id),
  buyer_id: text("buyer_id").notNull().references(() => buyers.id),
  number: text("number").notNull(),
  amount: integer("amount").notNull(),
  issued_at: integer("issued_at").notNull(),
  due_date: integer("due_date").notNull(),
  accepted_at: integer("accepted_at"),
  status: text("status").notNull(), // open, partly_paid, paid
  paid_amount: integer("paid_amount").notNull().default(0),
  key_account: bool("key_account").notNull(),
  disputed_part: integer("disputed_part"),
  // What TDS is a percent of (migration 1100). Null: the invoice amount.
  taxable_value: integer("taxable_value"),
});

export const promises = sqliteTable("promises", {
  id: id(),
  invoice_id: text("invoice_id").notNull().references(() => invoices.id),
  buyer_id: text("buyer_id").notNull().references(() => buyers.id),
  promised_date: integer("promised_date").notNull(),
  amount: integer("amount").notNull(),
  made_at: integer("made_at").notNull(),
  status: text("status").notNull(), // open, kept, broken
});

export const bankCredits = sqliteTable("bank_credits", {
  id: id(),
  merchant_id: text("merchant_id").notNull().references(() => merchants.id),
  amount: integer("amount").notNull(),
  remark: text("remark").notNull(),
  utr: text("utr").notNull(),
  date: integer("date").notNull(),
  matched_invoices: json<string[]>("matched_invoices").notNull(),
});

// How a simulated callee answers (Step 5b), one row per number. No row:
// the callee answers. Set from the call screen.
export const callSims = sqliteTable("call_sims", {
  callee: text("callee").primaryKey(),
  outcome: text("outcome", { enum: CALL_OUTCOMES }).notNull(),
  // What the callee says when they answer, and a promise or choice from it.
  reply: text("reply"),
  promise: text("promise"),
  updated_at: integer("updated_at").notNull(),
});
