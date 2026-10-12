// The evidence finder (a bounded agent step). Code gathers the candidates
// from the records: delivery proof, chats, past orders, any earlier RAY
// case on the payment, refunds and other charges, the Simulated fraud
// signals and an open Buyer Protection claim on the same payment. The
// investigate job (read-only tools, step cap 6, evidence on every finding)
// reads them with Razorpay's records and writes findings. The pack itself,
// its odds and its confidence come from the records in code, so a model
// never decides what is filed or how likely it is to win.
import { and, eq, sql } from "drizzle-orm";
import type { Adapters } from "@/adapters";
import { sameContact, type Dispute, type EvidenceType, type Payment } from "@/adapters/razorpay";
import type { Ai } from "@/ai";
import type { CaseEvidence } from "@/ai/jobs/investigate";
import * as s from "@/db/schema";
import type { EngineContext, Finding } from "@/engine/specialist";
import type { Case } from "@/engine/state-machine";
import { BANK_COMPLAINT, formatDate, formatMoney, formatTime } from "@/guards";
import { createReadTools, type ReadToolRunner } from "@/tools";
import { idAliases } from "../shared/stable-ids";
import { cbBuyerProtectionClaims, cbFraudSignals } from "./schema";
import { confidenceOf, oddsOf, STRONG_PACK_ODDS, TYPE_LABEL, type DisputeType, type PackFacts } from "./rules";

const DAY = 24 * 60 * 60 * 1000;
// PNO's note when the customer confirmed the order arrived.
const ARRIVED_NOTE = "pno_arrived";

export type Pack = {
  facts: PackFacts;
  odds: number;
  confidence: "sure" | "likely";
  strong: boolean;
  documents: Partial<Record<EvidenceType, string[]>>;
  summary: string;
  findings: Finding[];
  candidates: CaseEvidence[];
  customer: typeof s.customers.$inferSelect | null;
  orderNumber: string | null;
  agentSteps: number;
};

export function customerFor(ctx: EngineContext, merchantId: string, p: Payment) {
  return ctx.repo.customers.list(eq(s.customers.merchant_id, merchantId)).find((c) => sameContact(p, { contact: c.phone, email: c.email })) ?? null;
}

const when = (at: number) => `${formatTime(at)} on ${formatDate(at)}`;

export async function findEvidence(ctx: EngineContext, a: Adapters, ai: Ai, kase: Case, d: Dispute, type: DisputeType): Promise<Pack> {
  const m = kase.merchant_id;
  const rzp = a.razorpay(m);
  const p = await rzp.fetchPayment(d.payment_id);
  const customer = customerFor(ctx, m, p);
  const candidates: CaseEvidence[] = [];
  const findings: Finding[] = [];
  const documents: Partial<Record<EvidenceType, string[]>> = { billing_proof: [p.id] };
  const doc = (k: EvidenceType, id: string) => (documents[k] = [...(documents[k] ?? []), id]);

  // The store order and its history: delivery proof, or that it never shipped.
  const order = a.store.hasStore(m) ? await a.store.getOrder(m, { paymentId: p.id }).catch(() => null) : null;
  const history = (order?.status_history ?? []) as { status: string; at: number; note?: string }[];
  const shippedAt = history.find((h) => h.status === "completed")?.at ?? null;
  const shipped = order?.status === "completed";
  const neverShipped = !order || order.status === "pending" || order.status === "cancelled" || (order.status === "processing" && !shippedAt);
  if (order) {
    const note = history.find((h) => h.note)?.note;
    candidates.push({ id: order.id, type: "store_order", summary: `Order ${order.number} is ${order.status}${note ? ` (${note})` : ""}` });
    if (shipped) {
      doc("shipping_proof", order.id);
      findings.push({ text: `Order ${order.number} was marked shipped${shippedAt ? ` at ${when(shippedAt)}` : ""}${note ? `: "${note}"` : ""}.`, evidenceRef: order.id });
    } else {
      findings.push({ text: `Order ${order.number} is ${order.status}; it never shipped.`, evidenceRef: order.id });
    }
  } else {
    findings.push({ text: "Your store has no order for this payment.", evidenceRef: p.id });
  }

  // Refunds and other charges at Razorpay.
  const refunds = (await rzp.listRefunds(p.id)).filter((r) => r.status !== "failed");
  for (const r of refunds) {
    doc("refund_confirmation", r.id);
    candidates.push({ id: r.id, type: "refund", summary: `Refund of ${formatMoney(r.amount)} at ${when(r.created_at)}` });
    findings.push({ text: `Razorpay refunded ${formatMoney(r.amount)} on this payment at ${when(r.created_at)}.`, evidenceRef: r.id });
  }
  const others = ctx.repo.rzpPayments
    .list(and(eq(s.rzpPayments.merchant_id, m), eq(s.rzpPayments.status, "captured"), eq(s.rzpPayments.amount, p.amount)))
    .filter((o) => o.id !== p.id && sameContact(o, p) && Math.abs(o.created_at - p.created_at) <= DAY);
  const singleCharge = others.length === 0;
  if (type === "duplicate") {
    findings.push(
      singleCharge
        ? { text: `Razorpay charged ${formatMoney(p.amount)} once at ${when(p.created_at)}; there's no second charge from this customer.`, evidenceRef: p.id }
        : { text: `There's a second charge of ${formatMoney(p.amount)} from this customer at ${when(others[0].created_at)}.`, evidenceRef: others[0].id },
    );
  }

  // Chats with the customer, on any case.
  const addresses = [customer?.phone, customer?.email, p.contact, p.email].filter((x): x is string => !!x);
  const chats = [...new Map(addresses.flatMap((x) => a.messaging.thread(m, x)).map((msg) => [msg.id, msg])).values()].filter((msg) => msg.channel !== "call");
  for (const msg of chats.slice(-5)) {
    doc("customer_communication", msg.id);
    candidates.push({ id: msg.id, type: msg.direction === "in" ? "message_in" : "message_out", summary: `${msg.direction === "in" ? "Customer wrote" : "You wrote"}: ${msg.body}` });
  }
  if (chats.length) findings.push({ text: `${chats.length} message${chats.length > 1 ? "s" : ""} with the customer are on file.`, evidenceRef: chats.at(-1)!.id });

  // Past orders by the same customer.
  const pastOrders = customer
    ? ctx.repo.storeOrders.list(and(eq(s.storeOrders.merchant_id, m), eq(s.storeOrders.customer_id, customer.id))).filter((o) => o.id !== order?.id && o.status === "completed")
    : [];
  for (const o of pastOrders) candidates.push({ id: o.id, type: "past_order", summary: `Earlier order ${o.number}, ${o.status}` });

  // Any earlier RAY case on this payment, and whether the customer
  // confirmed it arrived there.
  const earlier = ctx.repo.cases.list(and(eq(s.cases.merchant_id, m), eq(s.cases.payment_id, p.id))).filter((c) => c.id !== kase.id);
  let deliveryConfirmed = false;
  for (const c of earlier) {
    const arrived = ctx.repo.caseEvents.listByCase(c.id).find((e) => e.payload.kind === ARRIVED_NOTE);
    candidates.push({ id: c.id, type: "earlier_case", summary: `Earlier RAY case (${c.moment}), ${c.state}${c.outcome ? `, ${c.outcome}` : ""}${arrived ? ", the customer confirmed it arrived" : ""}` });
    if (arrived) {
      deliveryConfirmed = true;
      doc("proof_of_service", arrived.evidence_ref ?? c.id);
      findings.push({ text: "On an earlier case, the customer told you the order arrived.", evidenceRef: arrived.evidence_ref ?? arrived.id });
    }
  }

  // An open Buyer Protection claim (Simulated) or a bank complaint on the same payment.
  const claims = a.db
    .select()
    .from(cbBuyerProtectionClaims)
    .where(and(eq(cbBuyerProtectionClaims.payment_id, p.id), eq(cbBuyerProtectionClaims.status, "open")))
    .all();
  const complaints = a.db
    .select({ id: s.caseEvents.id })
    .from(s.caseEvents)
    .innerJoin(s.cases, eq(s.cases.id, s.caseEvents.case_id))
    .where(and(eq(s.cases.merchant_id, m), sql`json_extract(${s.caseEvents.payload}, '$.kind') = ${BANK_COMPLAINT}`, sql`(${s.caseEvents.evidence_ref} = ${p.id} or json_extract(${s.caseEvents.payload}, '$.payment_id') = ${p.id})`))
    .all();
  for (const c of claims) {
    doc("customer_communication", c.id);
    candidates.push({ id: c.id, type: "buyer_protection_claim", summary: `Open Buyer Protection claim: ${c.summary}` });
    findings.push({ text: `There's an open Buyer Protection claim on this payment: "${c.summary}". It goes in the pack.`, evidenceRef: c.id });
  }
  for (const c of complaints) doc("customer_communication", c.id);

  // Fraud signals (Simulated): device and IP, address, Vulcan's result.
  const sig = a.db.select().from(cbFraudSignals).where(eq(cbFraudSignals.payment_id, p.id)).get();
  if (type === "fraud" && sig) {
    candidates.push({ id: `signals:${p.id}`, type: "fraud_signals", summary: `Vulcan ${sig.vulcan_result}; device seen before ${sig.device_seen_before}; address matches ${sig.address_matches}; IP ${sig.ip_country}` });
    findings.push({
      text:
        sig.vulcan_result === "flagged"
          ? "Vulcan flagged this payment as fraud (Simulated)."
          : `Vulcan didn't flag this payment (Simulated). Device ${sig.device_seen_before ? "seen on earlier orders" : "new"}, address ${sig.address_matches ? "matches" : "doesn't match"} earlier orders.`,
      evidenceRef: p.id,
    });
    if (sig.vulcan_result === "clear" && sig.device_seen_before) doc("access_activity_log", p.id);
  }
  if (type === "fraud" && pastOrders.length) findings.push({ text: `${customer?.name ?? "This customer"} has ${pastOrders.length} earlier completed order${pastOrders.length > 1 ? "s" : ""}.`, evidenceRef: pastOrders[0].id });

  const facts: PackFacts = {
    type,
    shipped,
    deliveryConfirmed,
    neverShipped,
    orderCancelled: order?.status === "cancelled",
    refunded: refunds.length > 0,
    singleCharge,
    chats: chats.length,
    buyerProtectionClaim: claims.length > 0 || complaints.length > 0,
    priorOrders: pastOrders.length,
    fraud: sig ? { vulcan: sig.vulcan_result, deviceSeenBefore: sig.device_seen_before, addressMatches: sig.address_matches, ipCountry: sig.ip_country } : null,
  };
  const odds = oddsOf(facts);

  // The bounded agent step: reads Razorpay's records and the candidates.
  const agent = await agentFindings(ctx, a, ai, kase, d, p, type, candidates, findings);

  const summary = [
    `${TYPE_LABEL[type][0].toUpperCase()}${TYPE_LABEL[type].slice(1)} dispute on ${formatMoney(p.amount)} paid at ${when(p.created_at)}${order ? ` for order ${order.number}` : ""}.`,
    ...findings.map((f) => f.text),
  ]
    .join(" ")
    .slice(0, 1000);

  return {
    facts,
    odds,
    confidence: confidenceOf(facts),
    strong: odds >= STRONG_PACK_ODDS,
    documents,
    summary,
    findings: [...findings, ...agent.extra],
    candidates,
    customer,
    orderNumber: order?.number ?? null,
    agentSteps: agent.steps,
  };
}

async function agentFindings(
  ctx: EngineContext,
  a: Adapters,
  ai: Ai,
  kase: Case,
  d: Dispute,
  p: Payment,
  type: DisputeType,
  candidates: CaseEvidence[],
  code: Finding[],
): Promise<{ extra: Finding[]; steps: number }> {
  const merchant = ctx.repo.merchants.get(kase.merchant_id)!;
  const ids = idAliases();
  const real = createReadTools(a, kase.merchant_id);
  const tools: ReadToolRunner = async (tool, id) => ids.hide(await real(tool, id === null ? null : ids.show(id)));
  const req = ids.hide({
    case: {
      moment: "chargeback",
      merchant: merchant.name,
      dispute_id: d.id,
      payment_id: p.id,
      amount: formatMoney(d.amount),
      reason: d.reason,
      type,
      phase: d.phase,
      // What the pack needs: delivery proof, chats, past orders, any earlier RAY case.
      looking_for: ["delivery proof", "chats", "past orders", "earlier RAY case", "refund or single charge", "Buyer Protection claim"],
    },
    evidence: candidates,
  });
  const out = await ai.investigate(req, tools, { caseId: kase.id });
  const cited = new Set(code.map((f) => f.evidenceRef));
  const extra = ids.show(out.findings).filter((f) => !cited.has(f.evidenceRef));
  return { extra, steps: out.steps };
}
