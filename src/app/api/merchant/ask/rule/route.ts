// Rule cards from Ask RAY: "edit" re-describes the rule with a new amount,
// "approve" saves it. The plan is checked again here; nothing is trusted from
// the card.
import { z } from "zod";
import { getAdapters } from "@/adapters";
import { applyPlan, describePlan, planSchema } from "@/ask/rules";
import { handle } from "../../../dev/handle";

const input = z.object({ merchantId: z.string(), plan: planSchema, action: z.enum(["approve", "edit"]) });

export async function POST(req: Request) {
  return handle(async () => {
    const { merchantId, plan, action } = input.parse(await req.json());
    const a = getAdapters();
    if (action === "edit") return { card: describePlan(a, merchantId, plan) };
    return { ...applyPlan(a, merchantId, plan), card: describePlan(a, merchantId, plan) };
  });
}
