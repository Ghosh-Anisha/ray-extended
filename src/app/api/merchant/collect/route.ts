// The morning list's controls: run today's chase (one event per buyer) and
// log the merchant's own note on a case. Both go to handleEvent.
import { z } from "zod";
import { getAdapters } from "@/adapters";
import { getEngine } from "@/engine";
import { collectMorningRun, logMerchantNote } from "@/flows/collect/run";
import { morningList } from "@/flows/collect/morning";
import { enableBankingPlusDemo, saveCollectWorkflow } from "@/flows/collect/workflow";
import { handle } from "../../dev/handle";

const input = z.discriminatedUnion("action", [
  z.object({ action: z.literal("enable_banking_plus"), merchantId: z.string().min(1) }),
  z.object({ action: z.literal("save_workflow"), merchantId: z.string().min(1), buyerId: z.string().min(1), channel: z.enum(["engine", "email", "whatsapp"]), tone: z.enum(["gentle", "firm"]), timing: z.enum(["after_review", "next_morning"]), requireApproval: z.literal(true) }),
  z.object({ action: z.literal("morning"), merchantId: z.string().min(1) }),
  z.object({ action: z.literal("buyer"), merchantId: z.string().min(1), buyerId: z.string().min(1) }),
  z.object({ action: z.literal("note"), merchantId: z.string().min(1), caseId: z.string().min(1), text: z.string().trim().min(1).max(300) }),
]);

export async function POST(req: Request) {
  return handle(async () => {
    const x = input.parse(await req.json());
    if (x.action === "enable_banking_plus") {
      return enableBankingPlusDemo(getAdapters(), x.merchantId);
    }
    if (x.action === "save_workflow") {
      const a = getAdapters();
      return saveCollectWorkflow(a, { merchantId: x.merchantId, buyerId: x.buyerId, channel: x.channel, tone: x.tone, timing: x.timing, requireApproval: true });
    }
    if (x.action === "morning") {
      const results = await collectMorningRun(getEngine(), getAdapters(), x.merchantId);
      return { outcome: results.length ? "handled" : "nothing", buyers: results.length };
    }
    if (x.action === "buyer") {
      const a = getAdapters();
      const results = await collectMorningRun(getEngine(), a, x.merchantId, x.buyerId);
      const row = morningList(a, x.merchantId).rows.find((item) => item.buyerId === x.buyerId);
      return { outcome: results.at(-1)?.outcome ?? "nothing", buyer: row?.buyer ?? x.buyerId, caseId: row?.caseId, state: row?.state, next: row?.next, activity: row?.lastActivity };
    }
    const r = await logMerchantNote(getEngine(), getAdapters(), x);
    return { outcome: r.outcome };
  });
}
