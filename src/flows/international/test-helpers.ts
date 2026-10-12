// A seeded world on the fake clock with the paid-no-order and international
// flows registered (so routing between them is tested too), AI in replay
// mode. To record fixtures with another model client, set RAY_AI_BOOK to a
// module whose default export is a ModelClient and RAY_AI_CAPTURE_DIR to
// where record mode should write (see book.ts).
import { and, eq } from "drizzle-orm";
import { expect } from "vitest";
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
import { createInternationalSpecialist } from ".";
import { openCheckout, payByCard, type Buyer, type CardOutcome } from "./checkout";
import { createInternationalSim } from "./sim";

export const NOTENEST = "m_notenest";
export const PIXELFORGE = "m_pixelforge";
export const MIN = 60_000;
export const HOUR = 60 * MIN;

export const EMMA: Buyer = { name: "Emma Clarke", email: "emma.clarke@example.com", country: "US" };
export const OLIVER_PAY = "pay_PF_oliver_failed";

let book: ModelClient | null | undefined;
async function bookClient(): Promise<ModelClient | null> {
  if (book !== undefined) return book;
  const path = process.env.RAY_AI_BOOK;
  book = path ? ((await import(/* @vite-ignore */ path)).default as ModelClient) : null;
  return book;
}

export async function intlWorld() {
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
    registry: createRegistry([createPaidNoOrderSpecialist({ ai }), createInternationalSpecialist({ ai })]),
  });
  const sim = createInternationalSim(a.db, a.clock);

  const cases = () => repo.cases.list(eq(s.cases.moment, "international"));
  const caseFor = (paymentId: string) => repo.cases.list(eq(s.cases.payment_id, paymentId)).at(-1);
  const state = (caseId: string) => repo.cases.get(caseId)!;
  const events = (caseId: string) => repo.caseEvents.listByCase(caseId);
  const findings = (caseId: string) => events(caseId).filter((e) => e.type === "finding").map((e) => String(e.payload.text));
  const notes = (caseId: string, kind: string) => events(caseId).filter((e) => e.payload.kind === kind);
  const sent = (caseId?: string) =>
    a.db
      .select()
      .from(s.messages)
      .where(and(eq(s.messages.direction, "out"), ...(caseId ? [eq(s.messages.case_id, caseId)] : [])))
      .all();
  const actions = (caseId: string, tool?: string) => repo.actions.list(eq(s.actions.case_id, caseId)).filter((x) => !tool || x.tool === tool);
  const proposals = (caseId: string) => openProposals({ db: a.db, repo, clock: a.clock }, caseId);
  const tapLabel = async (caseId: string, label: string | RegExp) => {
    const p = proposals(caseId).find((x) => (typeof label === "string" ? x.label === label : label.test(x.label)));
    if (!p) throw new Error(`No proposal ${String(label)} on ${caseId}: ${proposals(caseId).map((x) => x.label).join(", ")}`);
    return tapSurface(engine, a, { caseId, choice: "approve", proposalId: p.id });
  };
  // A buyer opens checkout and pays by card with the given outcome.
  const checkout = async (o: { merchantId?: string; buyer?: Buyer; amount?: number; currency?: string; receipt?: string; outcome: CardOutcome; cardCountry?: string }) => {
    const merchantId = o.merchantId ?? NOTENEST;
    const order = openCheckout(a, { merchantId, amount: o.amount ?? 4_900, currency: o.currency ?? "USD", receipt: o.receipt ?? "nn_pro_annual_902", buyer: o.buyer ?? EMMA });
    const r = await payByCard(a, { merchantId, orderId: order.id, outcome: o.outcome, cardCountry: o.cardCountry });
    return { order, ...r, kase: caseFor(r.paymentId) };
  };
  const noFallbacks = () => expect(repo.aiCalls.list().filter((c) => !c.valid).map((c) => `${c.job} ${c.input_hash}`)).toEqual([]);

  return {
    a, repo, engine, sim, cases, caseFor, state, events, findings, notes, sent, actions, proposals, tapLabel, checkout, noFallbacks,
    close: () => {
      engine.stop();
      a.db.$client.close();
    },
  };
}
export type IntlWorld = Awaited<ReturnType<typeof intlWorld>>;
