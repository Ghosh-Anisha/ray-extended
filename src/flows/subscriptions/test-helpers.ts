// A seeded world on the fake clock with the paid-no-order and subscriptions
// flows registered, AI in replay mode (fixtures/ai). To record fixtures with
// another model client (Claude Code acting as the model), set RAY_AI_BOOK to
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
import { createPaidNoOrderSpecialist } from "@/flows/paid-no-order";
import { tap as tapSurface } from "@/surfaces/actions";
import { createSubscriptionsSpecialist } from ".";

export const FITLOOP = "m_fitloop";
export const STACKLY = "m_stackly";
export const SHARMA = "m_sharma_tutorials";
export const KARAN = { id: "cus_karan", sub: "sub_FL_karan", phone: "+919800000201", email: "karan.mehta@example.com" };
export const ACME = { id: "cus_acme", sub: "sub_ST_acme", email: "accounts@acmelogistics.example.com" };
export const NEHA = { id: "cus_neha", sub: "sub_STU_neha", phone: "+919800000203", email: "neha.gupta@example.com" };
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

let book: ModelClient | null | undefined;
async function bookClient(): Promise<ModelClient | null> {
  if (book !== undefined) return book;
  const path = process.env.RAY_AI_BOOK;
  book = path ? ((await import(/* @vite-ignore */ path)).default as ModelClient) : null;
  return book;
}

export async function subWorld() {
  const a = seededAdapters();
  const repo = createRepository(a.db);
  const client = await bookClient();
  const ai = (ctx: EngineContext) =>
    client
      ? createAi({ repo: ctx.repo, mode: "record", fixturesDir: process.env.RAY_AI_CAPTURE_DIR!, client })
      : createAi({ repo: ctx.repo, mode: "replay", fixturesDir: DEFAULT_FIXTURES_DIR });
  const engine = createEngine({
    db: a.db,
    clock: a.clock,
    adapters: a,
    registry: createRegistry([createPaidNoOrderSpecialist({ ai }), createSubscriptionsSpecialist({ ai })]),
  });

  const cases = (merchantId?: string) => repo.cases.list().filter((c) => !merchantId || c.merchant_id === merchantId);
  const only = (merchantId: string) => {
    const all = cases(merchantId);
    if (all.length !== 1) throw new Error(`Expected one case, found ${all.length}`);
    return all[0];
  };
  const state = (caseId: string) => repo.cases.get(caseId)!;
  const events = (caseId: string) => repo.caseEvents.listByCase(caseId);
  const notes = (caseId: string, kind: string) => events(caseId).filter((e) => e.payload.kind === kind);
  const sent = (caseId: string) =>
    a.db
      .select()
      .from(s.messages)
      .where(eq(s.messages.case_id, caseId))
      .all()
      .filter((m) => m.direction === "out" && m.channel !== "call");
  const actions = (caseId: string, tool?: string) => repo.actions.list(eq(s.actions.case_id, caseId)).filter((x) => !tool || x.tool === tool);
  const proposals = (caseId: string) => openProposals({ db: a.db, repo, clock: a.clock }, caseId);
  const tapLabel = async (caseId: string, label: string | RegExp) => {
    const p = proposals(caseId).find((x) => (typeof label === "string" ? x.label === label : label.test(x.label)));
    if (!p) throw new Error(`No proposal ${String(label)} on ${caseId}: ${proposals(caseId).map((x) => x.label).join(", ")}`);
    return tapSurface(engine, a, { caseId, choice: "approve", proposalId: p.id });
  };
  const emit = (merchantId: string, event: Parameters<typeof a.webhooks.emit>[0]["event"], subscriptionId: string) =>
    a.webhooks.emit({ merchantId, event, subscriptionId });
  const says = (merchantId: string, from: string, body: string, channel: "whatsapp" | "email" = "whatsapp") =>
    engine.receiveMessage({ merchantId, channel, from, body });

  // A new FitLoop sign-up that never finished: created, with its first
  // invoice issued (paying it authorises the AutoPay).
  const signUp = (p: { minutesAgo: number; errorReason?: string | null }) => {
    const at = a.clock.now() - p.minutesAgo * MIN;
    repo.customers.insert({ id: "cus_riya", merchant_id: FITLOOP, name: "Riya Kapoor", email: "riya.kapoor@example.com", phone: "+919800000211" });
    repo.subscriptions.insert({
      id: "sub_FL_riya", merchant_id: FITLOOP, customer_id: "cus_riya", status: "created", plan: "FitLoop Monthly", amount: 49_900,
      retries_left: 3, pending_invoice_id: "inv_FL_riya_1", b2b: false, lifetime_value: 0, started_at: at,
    });
    repo.mandates.insert({ id: "mdt_FL_riya", subscription_id: "sub_FL_riya", method: "upi_autopay", token_id: "token_FL_riya", status: "created", max_amount: 200_000 });
    repo.subInvoices.insert({
      id: "inv_FL_riya_1", subscription_id: "sub_FL_riya", amount: 49_900, status: "issued", attempts: 1, error_reason: p.errorReason ?? null,
      billing_start: at, billing_end: at + 30 * DAY,
    });
    return "sub_FL_riya";
  };

  const approveRule = (merchantId: string, ruleJson: Record<string, unknown>, text: string) =>
    repo.playbookRules.insert({ id: newId("rule"), merchant_id: merchantId, moment: "subscription", rule_json: ruleJson, text, source: "merchant", status: "approved", approved_at: a.clock.now() });

  const fallbacks = () => repo.aiCalls.list().filter((c) => !c.valid).map((c) => `${c.job} ${c.input_hash}`);

  return {
    a, repo, engine, cases, only, state, events, notes, sent, actions, proposals, tapLabel, emit, says, signUp, approveRule, fallbacks,
    close: () => {
      engine.stop();
      a.db.$client.close();
    },
  };
}
export type SubWorld = Awaited<ReturnType<typeof subWorld>>;
