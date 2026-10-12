// A seeded world on the fake clock with the paid-no-order flow registered,
// AI in replay mode (fixtures/ai). To record fixtures with another model
// client (for example Claude Code acting as the model), set RAY_AI_BOOK to
// a module whose default export is a ModelClient and RAY_AI_CAPTURE_DIR to
// where record mode should write.
import { eq } from "drizzle-orm";
import { newId } from "@/adapters/ids";
import { seededAdapters } from "@/adapters/test-helpers";
import { createAi } from "@/ai";
import type { ModelClient } from "@/ai/client";
import { DEFAULT_FIXTURES_DIR } from "@/ai/fixtures";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import { createEngine } from "@/engine/engine";
import { openProposals } from "@/engine/orchestrator";
import { createRegistry, type EngineContext } from "@/engine/specialist";
import { tap as tapSurface } from "@/surfaces/actions";
import { createPaidNoOrderSpecialist } from ".";

export const LEAFY = "m_leafy_bakes";
export const PRIYA_PHONE = "+919800000101";
export const PRIYA_EMAIL = "priya.sharma@example.com";
export const PRIYA_PAY = "pay_LB1234PRIYA";
export const MIN = 60_000;
export const HOUR = 60 * MIN;

let book: ModelClient | null | undefined;
async function bookClient(): Promise<ModelClient | null> {
  if (book !== undefined) return book;
  const path = process.env.RAY_AI_BOOK;
  book = path ? ((await import(/* @vite-ignore */ path)).default as ModelClient) : null;
  return book;
}

export async function pnoWorld() {
  const a = seededAdapters();
  const repo = createRepository(a.db);
  const client = await bookClient();
  const ai = (ctx: EngineContext) =>
    client
      ? createAi({ repo: ctx.repo, mode: "record", fixturesDir: process.env.RAY_AI_CAPTURE_DIR!, client })
      : createAi({ repo: ctx.repo, mode: "replay", fixturesDir: DEFAULT_FIXTURES_DIR });
  const engine = createEngine({ db: a.db, clock: a.clock, adapters: a, registry: createRegistry([createPaidNoOrderSpecialist({ ai })]) });

  const caseFor = (paymentId: string) => repo.cases.list(eq(s.cases.payment_id, paymentId)).at(-1);
  const only = () => {
    const all = repo.cases.list();
    if (all.length !== 1) throw new Error(`Expected one case, found ${all.length}`);
    return all[0];
  };
  const events = (caseId: string) => repo.caseEvents.listByCase(caseId);
  const findings = (caseId: string) => events(caseId).filter((e) => e.type === "finding");
  const sent = (caseId: string) =>
    a.db
      .select()
      .from(s.messages)
      .where(eq(s.messages.case_id, caseId))
      .all()
      .filter((m) => m.direction === "out");
  const proposals = (caseId: string) => openProposals({ db: a.db, repo, clock: a.clock }, caseId);
  const tapLabel = async (caseId: string, label: string | RegExp) => {
    const p = proposals(caseId).find((x) => (typeof label === "string" ? x.label === label : label.test(x.label)));
    if (!p) throw new Error(`No proposal ${String(label)} on ${caseId}: ${proposals(caseId).map((x) => x.label).join(", ")}`);
    return tapSurface(engine, a, { caseId, choice: "approve", proposalId: p.id });
  };
  const says = (customer: string, body: string, channel: "whatsapp" | "email" = "whatsapp") =>
    engine.receiveMessage({ merchantId: LEAFY, channel, from: customer, body });
  const state = (caseId: string) => repo.cases.get(caseId)!;

  // A fresh Razorpay order, payment and (optionally) store order for a test.
  const payment = (p: {
    id: string;
    amount: number;
    contact: string;
    email?: string | null;
    status?: "captured" | "authorized" | "failed";
    utr?: string;
    minutesAgo: number;
    receipt: string;
    order?: { number: string; status: "pending" | "processing" | "cancelled"; customerId: string; item: string; withPayment?: boolean } | null;
  }) => {
    const at = a.clock.now() - p.minutesAgo * MIN;
    const orderId = `order_${p.id.slice(4)}`;
    repo.rzpOrders.insert({ id: orderId, merchant_id: LEAFY, status: p.status === "captured" ? "paid" : "attempted", amount: p.amount, receipt: p.receipt, created_at: at - MIN });
    repo.rzpPayments.insert({
      id: p.id, merchant_id: LEAFY, order_id: orderId, status: p.status ?? "captured", amount: p.amount, method: "upi", contact: p.contact,
      email: p.email ?? null, vpa: "someone@okaxis", utr: p.utr ?? null, receipt: p.receipt, created_at: at, captured_at: p.status === "captured" || !p.status ? at + 5_000 : null,
    });
    if (p.order) {
      const product = repo.products.list(eq(s.products.merchant_id, LEAFY)).find((x) => x.name === p.order!.item)!;
      repo.storeOrders.insert({
        id: `so_${p.receipt}`, number: p.order.number, merchant_id: LEAFY, customer_id: p.order.customerId, status: p.order.status,
        status_history: [{ status: p.order.status, at: at - MIN }], razorpay_order_id: orderId, receipt: p.receipt,
        payment_id: p.order.withPayment ? p.id : null, total: p.amount, items: [{ name: product.name, qty: 1, price: product.price, stock: product.stock }],
        stock: product.stock, created_at: at - MIN,
      });
    }
    return { orderId, at };
  };

  const setAutoMessages = (on: boolean) =>
    repo.playbookRules.insert({
      id: newId("rule"), merchant_id: LEAFY, moment: "paid_no_order", rule_json: { setting: "auto_customer_messages", on, tool: "send_message", kind: "auto_customer" },
      text: "Send automatic customer messages", source: "merchant", status: "approved", approved_at: a.clock.now(),
    });

  return { a, repo, engine, caseFor, only, events, findings, sent, proposals, tapLabel, says, state, payment, setAutoMessages, close: () => { engine.stop(); a.db.$client.close(); } };
}
export type PnoWorld = Awaited<ReturnType<typeof pnoWorld>>;
