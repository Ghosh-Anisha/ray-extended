// The demo world (docs/ui-rebuild.md section 4): Leafy Bakes on Tue 13 Oct
// 2026, 10:00 AM IST. It is the base seed plus a month of Leafy history, then
// the live part is run through the real engine on a fake clock, so the cases
// that need the merchant really are waiting with real proposals:
//   - Priya (paid, no order), Rahul (charged twice), Neha (chargeback) and
//     Karan (wants to cancel) come from events;
//   - the duplicate chargeback is contested under the merchant's approved
//     rule and sits in its Stop window;
//   - a month of closed cases and the cases RAY is already handling are
//     built through the repositories and the state machine (demo-history,
//     demo-handling).
// Home's numbers are computed from these rows by surfaces/stats.ts.
// Runs once: by `npm run db:seed`, on first load, and on Reset demo.
import { and, eq, inArray, sql } from "drizzle-orm";
import { createAdapters } from "@/adapters";
import { fakeClock } from "@/adapters/clock";
import { createAi } from "@/ai";
import { createEngine } from "@/engine/engine";
import { createRegistry, type EngineContext } from "@/engine/specialist";
import { createChargebacksSpecialist } from "@/flows/chargebacks";
import { laneRuleId, proposeLanes } from "@/flows/chargebacks/lanes";
import { createPaidNoOrderSpecialist } from "@/flows/paid-no-order";
import { createSubscriptionsSpecialist } from "@/flows/subscriptions";
import { setRuleStatus } from "@/surfaces/actions";
import { merchantVoiceNote } from "@/surfaces/voice";
import type { Db } from "../client";
import { createRepository } from "../repository";
import * as s from "../schema";
import { DEMO_NOW, seed } from "../seed";
import { CASE_REF_NOTE } from "@/surfaces/refs";
import { seedHandling, seedLeafySubscriptions } from "./demo-handling";
import { seedHistory } from "./demo-history";
import { BUYERS, DAY, HOUR, INVOICES, ist, KARAN, LEAFY, MIN, NEHA, rupees } from "./demo-people";

// Bump when the demo world changes, so a database seeded earlier is rebuilt.
export const DEMO_SEED_VERSION = 1;

// The refs the story names (section 4).
const REFS = { priya: "RD-1042", rahul: "RD-1043", neha: "RD-1051", karan: "RD-1060", sanjay: "RD-1047" } as const;

function prepare(db: Db, t0: number) {
  const repo = createRepository(db);

  // The base seed's other two disputes (Meera, Deepa) are customers in this
  // story, not chargebacks. The duplicate one (Sanjay) was raised on 30 Sep.
  db.delete(s.disputes).where(inArray(s.disputes.id, ["disp_LB_meera", "disp_LB_deepa"])).run();
  repo.disputes.update("disp_LB_sanjay", { created_at: ist("2026-09-30T23:10") });

  seedLeafySubscriptions(db, t0);

  // Neha K: ₹2,400 hamper, delivered by courier, "not received" chargeback, reply due Thu 15 Oct.
  repo.customers.insert({ id: NEHA.id, merchant_id: LEAFY, name: NEHA.name, email: NEHA.email, phone: NEHA.phone });
  const paid = ist("2026-10-04T16:30");
  repo.rzpOrders.insert({ id: "order_LB1190", merchant_id: LEAFY, status: "paid", amount: rupees(2400), receipt: "wc_1190", created_at: paid - 2 * MIN });
  repo.rzpPayments.insert({
    id: "pay_LB1190NEHA", merchant_id: LEAFY, order_id: "order_LB1190", status: "captured", amount: rupees(2400), method: "card", contact: NEHA.phone, email: NEHA.email,
    card_last4: "7712", card_country: "IN", receipt: "wc_1190", created_at: paid, captured_at: paid + 5_000,
  });
  repo.storeOrders.insert({
    id: "so_leafy_1190", number: "#1190", merchant_id: LEAFY, customer_id: NEHA.id, status: "completed",
    status_history: [
      { status: "processing", at: paid + 20 * MIN },
      { status: "completed", at: paid + 2 * DAY, note: "Shipped by courier" },
      { status: "completed", at: paid + 4 * DAY, note: "Delivered, signed for by N. Kumar" },
    ],
    razorpay_order_id: "order_LB1190", receipt: "wc_1190", payment_id: "pay_LB1190NEHA", total: rupees(2400), items: [{ name: "Cookie hamper", qty: 1, price: rupees(2400), stock: 5 }], stock: 5, created_at: paid - 2 * MIN,
  });
  repo.disputes.insert({
    id: "disp_LB_nehak", merchant_id: LEAFY, payment_id: "pay_LB1190NEHA", amount: rupees(2400), reason_code: "13.1", reason: "Product not received", network: "Visa", phase: "chargeback",
    deducted: true, respond_by: ist("2026-10-15T18:00"), status: "open", lane: null, created_at: ist("2026-10-12T18:00"),
  });

  // What Neha wrote before she went to her bank (the delivery proof says it arrived on 8 Oct).
  const WA = "wa:leafy-bakes";
  repo.messages.insertMany([
    { id: "msg_demo_neha_1", case_id: null, channel: "whatsapp", direction: "in", from: NEHA.phone, to: WA, sender_mode: null, body: "Hi, my cookie hamper hasn't arrived yet. It has been 5 days since I ordered.", template_id: null, within_24h: true, at: ist("2026-10-09T18:20") },
    { id: "msg_demo_neha_2", case_id: null, channel: "whatsapp", direction: "out", from: WA, to: NEHA.phone, sender_mode: "merchant_inbox", body: "Hi Neha, the courier shows your hamper was delivered on 8 Oct and signed for by N. Kumar. Could you check with your family or neighbours?", template_id: null, within_24h: true, at: ist("2026-10-09T18:45") },
    { id: "msg_demo_neha_3", case_id: null, channel: "whatsapp", direction: "in", from: NEHA.phone, to: WA, sender_mode: null, body: "I asked everyone, nobody has it. I will ask my bank for the money back.", template_id: null, within_24h: true, at: ist("2026-10-11T20:05") },
  ]);

  // Corporate gifting: six buyers, their invoices, one broken promise and one unmatched bank credit.
  repo.buyers.insertMany(
    BUYERS.map((b) => ({
      id: b.id, merchant_id: LEAFY, name: b.name, contact_name: b.contact, email: b.email, phone: b.phone, avg_days_late: b.avgLate, pay_history: b.history,
      usual_tds_rate: b.tds, key_account: b.key,
    })),
  );
  repo.messagingConsents.insertMany(
    BUYERS.flatMap((b) =>
      (["email", "whatsapp", "call"] as const)
        .filter((ch) => b.id === "buy_lb_acme" || ch !== "call")
        .map((ch) => ({ id: `cons_${b.id}_${ch}`, buyer_id: b.id, channel: ch, status: "opted_in" as const, source: "onboarding form", address: ch === "email" ? null : b.phone, updated_at: t0 - 90 * DAY })),
    ),
  );
  const buyerOf = new Map(BUYERS.map((b) => [b.id, b]));
  repo.invoices.insertMany(
    INVOICES.map((i) => {
      const due = ist(i.dueIso);
      return {
        id: i.id, merchant_id: LEAFY, buyer_id: i.buyer, number: `LB/26-27/${i.no}`, amount: rupees(i.amount), issued_at: due - 30 * DAY, due_date: due, accepted_at: due - 29 * DAY,
        status: i.status, paid_amount: i.status === "paid" ? rupees(i.amount) : 0, key_account: buyerOf.get(i.buyer)!.key, disputed_part: null,
      };
    }),
  );
  repo.promises.insert({ id: "prm_LB_metro", invoice_id: "inv_LB_104", buyer_id: "buy_lb_metro", promised_date: t0 - 4 * DAY, amount: rupees(100_000), made_at: t0 - 12 * DAY, status: "broken" });
  // The bank credit the story fires: Orchid pays two invoices in one transfer, less 2% TDS.
  repo.bankCredits.insert({
    id: "bc_LB_orchid", merchant_id: LEAFY, amount: Math.round(rupees(155_000) * 0.98), remark: "RTGS ORCHID EVENTS PAYMENT", utr: "HDFCR52026101312", date: t0 - 3 * HOUR, matched_invoices: [],
  });

  // Rules: the lane that contests duplicate chargebacks is on (approved below), and
  // RAY suggests one more after the merchant made the same choice three times.
  repo.playbookRules.insert({
    id: "rule_pattern_refund_dup_leafy", merchant_id: LEAFY, moment: "paid_no_order", rule_json: { tool: "refund", when: "duplicate", max: 49_900 },
    text: "Refund duplicate charges under ₹500 automatically", source: "pattern", status: "proposed", approved_at: null,
  });
  repo.memory.insert({
    id: "mem_LB_dup_refund", kind: "pattern", text: "Refunded the extra payment on a duplicate charge under ₹500 three times in a row", vector: { refund: 1, duplicate: 1, under_500: 1 }, merchant_id: LEAFY,
  });
}

// Filler payments so success rate and today's sales are computed from real
// volume: exactly 500 payments in the last 7 days, 29 of them failed.
function seedPaymentVolume(db: Db, now: number) {
  const repo = createRepository(db);
  const from = now - 7 * DAY;
  const counts = db
    .select({ status: s.rzpPayments.status, n: sql<number>`count(*)` })
    .from(s.rzpPayments)
    .where(and(eq(s.rzpPayments.merchant_id, LEAFY), sql`${s.rzpPayments.created_at} >= ${from}`, inArray(s.rzpPayments.status, ["captured", "failed"])))
    .groupBy(s.rzpPayments.status)
    .all();
  const have = { captured: counts.find((c) => c.status === "captured")?.n ?? 0, failed: counts.find((c) => c.status === "failed")?.n ?? 0 };
  const rows: (typeof s.rzpPayments.$inferInsert)[] = [];
  let seedNo = 7;
  const rand = () => {
    seedNo = (seedNo * 1103515245 + 12345) % 2147483648;
    return seedNo / 2147483648;
  };
  const make = (status: "captured" | "failed", i: number) => {
    const at = from + Math.floor(rand() * (now - from - 60 * MIN));
    const amount = rupees([299, 349, 449, 499, 649, 899, 1299, 1499, 1850, 2499][Math.floor(rand() * 10)]);
    const card = rand() < 0.3;
    rows.push({
      id: `pay_LBF${String(i).padStart(4, "0")}`, merchant_id: LEAFY, order_id: null, status, amount, method: card ? "card" : "upi", contact: null, email: null,
      vpa: card ? null : "customer@okaxis", card_last4: card ? "4100" : null, card_country: card ? "IN" : null, receipt: `wc_f${i}`, created_at: at, captured_at: status === "captured" ? at + 5_000 : null,
      error_code: status === "failed" ? "BAD_REQUEST_ERROR" : null, error_source: status === "failed" ? "issuer" : null, error_reason: status === "failed" ? "payment_failed" : null,
    });
  };
  let i = 0;
  for (let n = have.captured; n < 471; n++) make("captured", ++i);
  for (let n = have.failed; n < 29; n++) make("failed", ++i);
  for (let at = 0; at < rows.length; at += 100) repo.rzpPayments.insertMany(rows.slice(at, at + 100));
}

// What a rehearsal (demo-fixtures.ts) gets to drive: the seeded world, live.
export type DemoWorld = { db: Db; a: ReturnType<typeof createAdapters>; engine: ReturnType<typeof createEngine>; repo: ReturnType<typeof createRepository> };

export async function seedDemo(db: Db, opts: { rehearse?: (w: DemoWorld) => Promise<void> } = {}): Promise<{ now: number }> {
  // The live part starts 25 minutes before the story's 10:00 AM.
  const t0 = DEMO_NOW - 25 * MIN;
  seed(db, t0);
  prepare(db, t0);
  seedHistory(db);
  await seedHandling(db);
  seedPaymentVolume(db, DEMO_NOW);

  // The engine, on a fake clock, with the AI always replaying recorded answers.
  const clock = fakeClock(t0);
  const a = createAdapters(db, clock, { RAZORPAY_MODE: "mock" });
  const ai = (ctx: EngineContext) => createAi({ repo: ctx.repo, mode: "replay" });
  const engine = createEngine({
    db,
    clock,
    adapters: a,
    registry: createRegistry([createPaidNoOrderSpecialist({ ai }), createSubscriptionsSpecialist({ ai }), createChargebacksSpecialist({ ai })]),
  });
  const repo = createRepository(db);
  const caseOf = (where: ReturnType<typeof eq>) => db.select().from(s.cases).where(where).orderBy(s.cases.opened_at).all().at(-1)!;
  const name = (caseId: string, ref: string) =>
    repo.caseEvents.insert({ id: `cev_ref_${ref}`, case_id: caseId, at: clock.now(), type: "note", payload: { kind: CASE_REF_NOTE, ref }, evidence_ref: caseId });
  const goTo = (at: number) => engine.advanceBy(at - clock.now());

  try {
    // Rules the merchant has switched on: contest duplicate chargebacks, and capture authorised payments.
    proposeLanes(db, LEAFY);
    setRuleStatus(a, { merchantId: LEAFY, ruleId: laneRuleId(LEAFY, "contest"), status: "approved" });
    setRuleStatus(a, { merchantId: LEAFY, ruleId: `rule_setup_capture_${LEAFY}`, status: "approved" });

    // 9:35 Rahul was charged twice; Neha's chargeback arrives.
    await a.webhooks.emit({ merchantId: LEAFY, event: "payment.captured", paymentId: "pay_LB1235RAHUL2" });
    name(caseOf(eq(s.cases.payment_id, "pay_LB1235RAHUL2")).id, REFS.rahul);
    await goTo(t0 + MIN);
    await engine.receiveMessage({ merchantId: LEAFY, channel: "whatsapp", from: "+919800000102", body: "Bhaiya banana bread ke 499 do baar kat gaye. Ek wapas kar do please." });
    await goTo(t0 + 2 * MIN);
    await a.webhooks.emit({ merchantId: LEAFY, event: "payment.dispute.created", disputeId: "disp_LB_nehak" });
    const nehaCase = caseOf(eq(s.cases.payment_id, "pay_LB1190NEHA"));
    name(nehaCase.id, REFS.neha);
    // Her earlier chat is part of the case now that it exists.
    for (const id of ["msg_demo_neha_1", "msg_demo_neha_2", "msg_demo_neha_3"]) repo.messages.update(id, { case_id: nehaCase.id });

    // 9:40 the duplicate chargeback: contested under the rule, 2 hours to Stop it.
    await goTo(DEMO_NOW - 20 * MIN);
    await a.webhooks.emit({ merchantId: LEAFY, event: "payment.dispute.created", disputeId: "disp_LB_sanjay" });
    name(caseOf(eq(s.cases.payment_id, "pay_LB1210SANJAY")).id, REFS.sanjay);

    // 9:44 Karan asks to cancel.
    await goTo(DEMO_NOW - 16 * MIN);
    await engine.receiveMessage({ merchantId: LEAFY, channel: "whatsapp", from: KARAN.phone, body: "Please cancel my cookie box plan, it's too expensive for me right now." });
    const karan = caseOf(eq(s.cases.moment, "subscription"));
    name(karan.id, REFS.karan);
    // What is at stake on a cancel request is what the subscriber is worth: ₹4,252 so far (₹499 a month).
    repo.cases.update(karan.id, { amount: repo.subscriptions.get("sub_LB_karan")!.lifetime_value });

    // 9:48 Priya: a Hinglish voice note, then an email.
    await goTo(DEMO_NOW - 12 * MIN);
    await a.webhooks.emit({ merchantId: LEAFY, event: "payment.captured", paymentId: "pay_LB1234PRIYA" });
    const priya = caseOf(eq(s.cases.payment_id, "pay_LB1234PRIYA"));
    name(priya.id, REFS.priya);
    await goTo(DEMO_NOW - 10 * MIN);
    await engine.receiveVoiceNote({ merchantId: LEAFY, from: "+919800000101", sampleId: "priya_hinglish" });
    await goTo(DEMO_NOW - 8 * MIN);
    await engine.receiveMessage({ merchantId: LEAFY, channel: "email", from: "priya.sharma@example.com", body: "Money deducted but no order!!" });

    // 9:55 the merchant answers Rahul's card with a voice note; it only picks the card to show.
    await goTo(DEMO_NOW - 5 * MIN);
    await merchantVoiceNote(a, { merchantId: LEAFY, caseId: caseOf(eq(s.cases.payment_id, "pay_LB1235RAHUL2")).id, sampleId: "merchant_refund" });

    // 10:00
    await goTo(DEMO_NOW);
    // Only the fixture tooling does this, on a throwaway database.
    await opts.rehearse?.({ db, a, engine, repo });
  } finally {
    engine.stop();
  }
  return { now: DEMO_NOW };
}
