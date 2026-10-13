// A seeded world on the fake clock with the Collect flow registered and the
// remark/advice reader in replay mode (fixtures/ai). PackRight is the
// Banking+ merchant; the seed time is 12 Oct, 10:00 AM IST.
import { and, eq } from "drizzle-orm";
import { seededAdapters } from "@/adapters/test-helpers";
import { createAi } from "@/ai";
import { DEFAULT_FIXTURES_DIR } from "@/ai/fixtures";
import { writeSpec } from "@/ai/jobs/write";
import { runJob } from "@/ai/runner";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import { createEngine } from "@/engine/engine";
import { openProposals } from "@/engine/orchestrator";
import { createRegistry, type EngineContext } from "@/engine/specialist";
import { requestChange, tap as tapSurface } from "@/surfaces/actions";
import { createCollectSpecialist } from ".";
import { defaultReader } from "./advice";
import { invoicesOf, openCaseForBuyer, owedOn } from "./data";
import { bankCreditArrives, collectHandoff, collectMorningRun, creditEvent, logMerchantNote, type NewCredit } from "./run";
import { DAY, HOUR } from "./stages";

export const PR = "m_packright";
export const BUYERS = {
  gill: "buy_gill_agro",
  bansal: "buy_bansal_traders",
  sidhu: "buy_sidhu_dairy",
  mehra: "buy_mehra_snacks",
  kohli: "buy_kohli_exports",
} as const;
export { DAY, HOUR };

export function collectWorld() {
  const a = seededAdapters();
  const repo = createRepository(a.db);
  const ai = (ctx: EngineContext) => createAi({ repo: ctx.repo, mode: "replay", fixturesDir: DEFAULT_FIXTURES_DIR }).ctx;
  const engine = createEngine({ db: a.db, clock: a.clock, adapters: a, registry: createRegistry([createCollectSpecialist({ reader: defaultReader(ai), writer: (ctx, input, caseId) => runJob(ai(ctx), writeSpec, input, { caseId }) })]) });

  const buyer = (id: string) => repo.buyers.get(id)!;
  const caseOf = (buyerId: string) => openCaseForBuyer(a.db, PR, buyerId) ?? lastCaseOf(buyerId);
  const lastCaseOf = (buyerId: string) =>
    repo.cases
      .list(eq(s.cases.moment, "collect"))
      .filter((c) => repo.caseEvents.listByCase(c.id).some((e) => e.payload.kind === "collect_case" && e.payload.buyer_id === buyerId))
      .at(-1);
  const events = (caseId: string) => repo.caseEvents.listByCase(caseId);
  const notes = (caseId: string, kind: string) => events(caseId).filter((e) => e.payload.kind === kind);
  const findings = (caseId: string) => events(caseId).filter((e) => e.type === "finding").map((e) => String(e.payload.text));
  const proposals = (caseId: string) => openProposals({ db: a.db, repo, clock: a.clock }, caseId);
  const state = (caseId: string) => repo.cases.get(caseId)!;
  const ask = (caseId: string) => String(notes(caseId, "merchant_question").at(-1)?.payload.text ?? "");

  // Everything sent to a buyer's addresses, on any channel.
  const toBuyer = (buyerId: string) => {
    const b = buyer(buyerId);
    return a.db
      .select()
      .from(s.messages)
      .all()
      .filter((m) => m.direction === "out" && (m.to === b.email || m.to === b.phone));
  };

  const tapLabel = async (caseId: string, label: string | RegExp, choice: "approve" | "decline" = "approve") => {
    const p = proposals(caseId).find((x) => (typeof label === "string" ? x.label === label : label.test(x.label)));
    if (!p) throw new Error(`No proposal ${String(label)} on ${caseId}: ${proposals(caseId).map((x) => x.label).join(", ") || "none"}`);
    return tapSurface(engine, a, { caseId, choice, proposalId: p.id });
  };
  const change = (caseId: string, text: string) => requestChange(engine, a, { caseId, text });

  const replies = (buyerId: string, body: string, channel: "email" | "whatsapp" = "email") => {
    const b = buyer(buyerId);
    return engine.receiveMessage({ merchantId: PR, channel, from: channel === "email" ? b.email! : b.phone!, body });
  };
  const voiceNote = (buyerId: string, sampleId: string) => engine.receiveVoiceNote({ merchantId: PR, from: buyer(buyerId).phone!, sampleId });

  const morning = () => collectMorningRun(engine, a, PR);
  const credit = (c: NewCredit) => bankCreditArrives(engine, a, PR, c);
  const seededCredit = (id: string) => creditEvent(engine, a, PR, id);
  const merchantNote = (caseId: string, text: string) => logMerchantNote(engine, a, { merchantId: PR, caseId, text });
  const handoff = (payload: Parameters<typeof collectHandoff>[3], sourceId?: string) => collectHandoff(engine, a, PR, payload, sourceId);
  const advance = (ms: number) => engine.advanceBy(ms);

  const invoices = (buyerId: string) =>
    a.db.select().from(s.invoices).where(and(eq(s.invoices.merchant_id, PR), eq(s.invoices.buyer_id, buyerId))).all();
  const caseInvoices = (caseId: string) => invoicesOf({ db: a.db, repo, clock: a.clock, adapters: a }, caseId);
  const owed = (invoiceId: string) => owedOn(a.db, repo.invoices.get(invoiceId)!);
  const promises = (invoiceId: string) => repo.promises.list(eq(s.promises.invoice_id, invoiceId));

  return {
    a, repo, engine, buyer, caseOf, events, notes, findings, proposals, state, ask, toBuyer, tapLabel, change, replies, voiceNote,
    morning, credit, seededCredit, merchantNote, handoff, advance, invoices, caseInvoices, owed, promises,
    close: () => { engine.stop(); a.db.$client.close(); },
  };
}
export type CollectWorld = ReturnType<typeof collectWorld>;
