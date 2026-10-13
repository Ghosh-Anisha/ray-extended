// U7 replay-only cases. These are deliberately built through the same case
// page data shape as live cases, but have no specialist: the logic is labelled
// Simulated and never creates an engine action.
import type { Db } from "../client";
import { createRepository } from "../repository";
import { createBuilder, type CaseSpec } from "./demo-build";
import { DAY, HOUR, LEAFY, MIN, rupees } from "./demo-people";

const CUSTOMER_ROWS = [
  { id: "cus_u7_aisha", name: "Aisha Verma", email: "aisha.verma@example.com", phone: "+919800000501" },
  { id: "cus_u7_rohan", name: "Rohan Iyer", email: "rohan.iyer@example.com", phone: "+919800000502" },
  { id: "cus_u7_lea", name: "Lea Fernandes", email: "lea.fernandes@example.com", phone: "+919800000503" },
  { id: "cus_u7_mihir", name: "Mihir Shah", email: "mihir.shah@example.com", phone: "+919800000504" },
] as const;

export function seedU7Cases(db: Db, now: number) {
  const repo = createRepository(db);
  repo.customers.insertMany(CUSTOMER_ROWS.map((c) => ({ ...c, merchant_id: LEAFY })));
  const b = createBuilder(db);
  const common = (at: number, person: (typeof CUSTOMER_ROWS)[number]) => ({ email: person.email, phone: person.phone });
  const specs: CaseSpec[] = [
    {
      id: "case_u7_whose_side", merchantId: LEAFY, moment: "whose_side", confidence: "sure", side: "razorpay", plugin: true,
      amount: rupees(1800), openedAt: now - 2 * HOUR, ref: "RD-1071", cause: "success_rate_drop", alert: "RAY spotted a success-rate drop by payment method.", keys: common(now, CUSTOMER_ROWS[0]),
      steps: [
        { at: now - 2 * HOUR, kind: "finding", text: "HDFC netbanking was down from 7:40 to 8:10 PM in Razorpay's downtime feed.", source: "Razorpay" },
        { at: now - 115 * MIN, kind: "finding", text: "Other banks stayed within the normal success-rate range.", source: "Razorpay" },
        { at: now - 110 * MIN, kind: "finding", text: "Payment updates are turned off in your store.", ok: false, source: "Store" },
        { at: now - 105 * MIN, kind: "in", channel: "email", from: CUSTOMER_ROWS[0].email, to: "support@leafybakes.example.com", body: "I tried twice but the payment page did not finish." },
        { at: now - 100 * MIN, kind: "note", payload: { kind: "investigated", reason: "RAY split the drop by method and bank.", side: "razorpay" } },
        { at: now - 95 * MIN, kind: "proposals", actions: [{ id: "u7_webhook_fix", label: "Turn payment updates back on", tool: "update_store_setting", args: { setting: "webhook", enabled: true }, covered: false }] },
        { at: now - 90 * MIN, kind: "move", to: "waiting_customer", reason: "Simulated analysis is complete" },
      ],
    },
    {
      id: "case_u7_ticket", merchantId: LEAFY, moment: "ticket", confidence: "likely", side: "razorpay", amount: rupees(499), openedAt: now - 5 * HOUR, ref: "RD-1072", cause: "ticket_sla", alert: "A support ticket has not had its promised update.", keys: common(now, CUSTOMER_ROWS[1]),
      steps: [
        { at: now - 5 * HOUR, kind: "finding", text: "Ticket RZ-218 is open at the payments support stage.", source: "Razorpay" },
        { at: now - 4 * HOUR, kind: "finding", text: "The next update was due 42 minutes ago.", ok: false, source: "Razorpay" },
        { at: now - 3 * HOUR, kind: "in", channel: "whatsapp", from: CUSTOMER_ROWS[1].phone, to: "wa:leafy-bakes", body: "Any update on the payment issue?" },
        { at: now - 170 * MIN, kind: "note", payload: { kind: "investigated", reason: "RAY found the open stage and missed SLA." } },
        { at: now - 160 * MIN, kind: "proposals", actions: [{ id: "u7_ticket_escalate", label: "Escalate Now", tool: "send_message", args: { to: "support@razorpay.example.com", body: "Please share the next update for ticket RZ-218." }, covered: false }] },
        { at: now - 150 * MIN, kind: "move", to: "waiting_customer", reason: "Simulated ticket follow-up is ready" },
      ],
    },
    {
      id: "case_u7_settlement", merchantId: LEAFY, moment: "settlement_hold", confidence: "sure", side: "razorpay", amount: rupees(24500), openedAt: now - DAY, ref: "RD-1073", cause: "settlement_review", alert: "A settlement is held for review.", keys: common(now, CUSTOMER_ROWS[2]),
      steps: [
        { at: now - DAY, kind: "finding", text: "₹24,500 is held; the review window is 2 days.", source: "Razorpay" },
        { at: now - 23 * HOUR, kind: "finding", text: "The evidence pack has payment, refund and KYC checks ready.", source: "Razorpay" },
        { at: now - 22 * HOUR, kind: "finding", text: "No store-side mismatch was found.", source: "Store" },
        { at: now - 21 * HOUR, kind: "note", payload: { kind: "investigated", reason: "RAY prepared the evidence pack and cash-impact timeline." } },
        { at: now - 20 * HOUR, kind: "proposals", actions: [{ id: "u7_settlement_pack", label: "Open evidence pack", tool: "send_message", args: { to: "merchant", body: "Evidence pack is ready for the settlement review." }, covered: false }] },
        { at: now - 19 * HOUR, kind: "move", to: "waiting_customer", reason: "Simulated settlement review is ready" },
      ],
    },
    {
      id: "case_u7_ai_chat", merchantId: LEAFY, moment: "ai_chat_order", confidence: "likely", side: "merchant", amount: rupees(1299), openedAt: now - 75 * MIN, ref: "RD-1074", cause: "ai_chat_drift", alert: "An AI-chat order does not match its payment.", keys: common(now, CUSTOMER_ROWS[3]),
      steps: [
        { at: now - 75 * MIN, kind: "finding", text: "The chat intent says chocolate box, 12 pieces.", source: "Customer" },
        { at: now - 70 * MIN, kind: "finding", text: "The store order says assorted cookies, 6 pieces.", ok: false, source: "Store" },
        { at: now - 65 * MIN, kind: "finding", text: "The payment is captured for ₹1,299.", source: "Razorpay" },
        { at: now - 60 * MIN, kind: "in", channel: "whatsapp", from: CUSTOMER_ROWS[3].phone, to: "wa:leafy-bakes", body: "I ordered the chocolate box in chat. The order looks different." },
        { at: now - 55 * MIN, kind: "note", payload: { kind: "investigated", reason: "RAY compared chat intent, store order and payment." } },
        { at: now - 50 * MIN, kind: "proposals", actions: [{ id: "u7_ai_chat_check", label: "Review order match", tool: "send_message", args: { to: CUSTOMER_ROWS[3].phone, body: "We are checking your chat order against the payment." }, covered: false }] },
        { at: now - 45 * MIN, kind: "move", to: "waiting_customer", reason: "Simulated order review is ready" },
      ],
    },
  ];
  for (const spec of specs) b.build(spec);
}
