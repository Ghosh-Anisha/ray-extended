import { afterEach, describe, expect, it } from "vitest";
import { morningList } from "./morning";
import { enableBankingPlusDemo, saveCollectWorkflow } from "./workflow";
import { caseView } from "@/surfaces/views";
import { BUYERS, collectWorld, PR } from "./test-helpers";

describe("simulated Banking+ Collect workflow setup", () => {
  const worlds: ReturnType<typeof collectWorld>[] = [];
  afterEach(() => { for (const world of worlds.splice(0)) world.close(); });

  it("enables only the demo path, persists reviewed workflow preferences, and links its invoice case", async () => {
    const w = collectWorld(); worlds.push(w);
    w.repo.merchants.update(PR, { banking_plus: false });
    expect(morningList(w.a, PR).offer).not.toBeNull();
    expect(enableBankingPlusDemo(w.a, PR).outcome).toBe("enabled_simulation");
    expect(w.repo.merchants.get(PR)?.banking_plus).toBe(true);
    expect(morningList(w.a, PR).offer).toBeNull();

    // Create the buyer case through the existing engine before saving a workflow.
    await w.morningFor(BUYERS.gill);
    const kase = w.caseOf(BUYERS.gill)!;
    const outboundBeforeSave = w.toBuyer(BUYERS.gill).length;
    const saved = saveCollectWorkflow(w.a, { merchantId: PR, buyerId: BUYERS.gill, channel: "email", tone: "gentle", timing: "after_review", requireApproval: true });
    expect(saved).toMatchObject({ outcome: "saved", caseId: kase.id, workflow: { buyerId: BUYERS.gill, channel: "email", tone: "gentle", timing: "after_review", requireApproval: true } });
    expect(morningList(w.a, PR).workflow).toMatchObject({ buyerId: BUYERS.gill, channel: "email", requireApproval: true });
    expect(w.events(kase.id).some((event) => event.payload.kind === "collect_workflow_saved" && event.payload.simulated === true)).toBe(true);
    expect(caseView(w.a, kase.id).events.some((event) => event.what === "Simulated Collect workflow saved; no reminder sent" && event.who === "You (merchant)")).toBe(true);
    expect(w.toBuyer(BUYERS.gill)).toHaveLength(outboundBeforeSave);
  });

  it("does not save a scheduled workflow when no scheduler exists or enable another merchant", () => {
    const w = collectWorld(); worlds.push(w);
    expect(() => enableBankingPlusDemo(w.a, "not-a-merchant")).toThrow("Merchant not found");
    enableBankingPlusDemo(w.a, PR);
    expect(() => saveCollectWorkflow(w.a, { merchantId: PR, buyerId: BUYERS.gill, channel: "engine", tone: "firm", timing: "next_morning", requireApproval: true })).toThrow("no background scheduler");
    expect(morningList(w.a, PR).workflow).toBeNull();
  });
});
