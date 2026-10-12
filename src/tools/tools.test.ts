// Read tools against the seed, the one tool list, and the rule that act
// tools are only reachable through guardedCall.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seededAdapters } from "@/adapters/test-helpers";
import { createReadTools } from "./read";
import { ACT_TOOLS, isActTool, isReadTool, READ_TOOLS } from "./names";

let a: ReturnType<typeof seededAdapters>;
beforeEach(() => {
  a = seededAdapters();
});
afterEach(() => a.db.$client.close());

describe("read tools", () => {
  it("read Razorpay records through the adapter, scoped to the merchant", async () => {
    const leafy = createReadTools(a, "m_leafy_bakes");
    expect(await leafy("get_payment", "pay_LB1234PRIYA")).toMatchObject({ evidence_ids: ["pay_LB1234PRIYA"], data: { status: "captured", amount: 129_900 } });
    expect((await leafy("get_order", "order_LB1234")).evidence_ids).toEqual(["order_LB1234"]);
    expect((await leafy("list_order_payments", "order_LB1235")).evidence_ids).toEqual(["pay_LB1235RAHUL1", "pay_LB1235RAHUL2"]);
    expect(await leafy("get_refunds", "pay_LB1234PRIYA")).toEqual({ evidence_ids: [], data: [] });
    expect((await leafy("get_dispute", "pay_LB1198MEERA")).evidence_ids).toEqual(["disp_LB_meera"]);
    expect((await leafy("get_dispute", "disp_LB_sanjay")).data).toMatchObject({ reason_code: "4834" });
    // Another merchant's payment is not found.
    expect(await createReadTools(a, "m_notenest")("get_payment", "pay_LB1234PRIYA")).toEqual({ evidence_ids: [], data: null });
  });

  it("read the store through its connector and the simulated logs from their tables", async () => {
    const leafy = createReadTools(a, "m_leafy_bakes");
    expect(await leafy("get_store_order", "#1234")).toMatchObject({ evidence_ids: ["so_leafy_1234"], data: { status: "pending" } });
    expect((await leafy("get_store_order", "pay_LB1235RAHUL1")).evidence_ids).toEqual(["so_leafy_1235"]);
    const settings = await leafy("get_store_settings", null);
    expect(settings.data).toMatchObject({ reachable: true, plugin_version: "4.8.2", webhook_enabled: true });
    // What the settings page shows, not the simulator's failure mode.
    expect(settings.data).not.toHaveProperty("failure_mode");
    const deliveries = await leafy("get_webhook_deliveries", "pay_LB1234PRIYA");
    expect(deliveries.evidence_ids).toEqual(["evt_LB_priya_captured", "evt_LB_priya_order_paid"]);
    expect(deliveries.data).toMatchObject([{ http_status: 200, processed: false }, { http_status: 200, processed: false }]);
  });

  it("share another merchant's plugin report without saying whose it is", async () => {
    const r = await createReadTools(a, "m_leafy_bakes")("get_plugin_reports", null);
    expect(r.evidence_ids).toEqual(["pr_woo_482_1"]);
    expect(r.data).toMatchObject({ plugin_version: "4.8.2", reports: [{ failure: "Webhook answered 200 but order stayed Pending", from_this_merchant: false }] });
    expect(JSON.stringify(r.data)).not.toContain("m_crumb_co");
  });

  it("report a store that is down as unreachable evidence", async () => {
    a.store.setFailure("m_leafy_bakes", "site_down");
    const leafy = createReadTools(a, "m_leafy_bakes");
    expect((await leafy("get_store_settings", null)).data).toMatchObject({ reachable: false, http_status: 503 });
    expect((await leafy("get_store_order", "#1234")).data).toMatchObject({ reachable: false });
  });

  it("read subscriptions, invoices, bank credits and downtimes", async () => {
    const sub = await createReadTools(a, "m_fitloop")("get_subscription", "sub_FL_karan");
    expect(sub.evidence_ids).toEqual(["sub_FL_karan", "inv_FL_karan_3", "mdt_FL_karan"]);
    const pr = createReadTools(a, "m_packright");
    const mehra = await pr("get_invoices", "buy_mehra_snacks");
    expect((mehra.data as { invoices: unknown[] }).invoices.length).toBeGreaterThan(0);
    expect(mehra.evidence_ids).toContain("prm_PR_1");
    expect((await pr("get_bank_credits", null)).evidence_ids.sort()).toEqual(["bc_PR_1", "bc_PR_2", "bc_PR_3"]);
    await a.webhooks.emit({ merchantId: "m_leafy_bakes", event: "payment.downtime.started", downtime: { method: "upi", id: "down_upi_1" } });
    expect((await createReadTools(a, "m_leafy_bakes")("get_downtimes", "pay_LB1234PRIYA")).evidence_ids).toEqual([]);
    expect((await createReadTools(a, "m_leafy_bakes")("get_downtimes", null)).evidence_ids).toEqual(["down_upi_1"]);
  });
});

describe("the tool lists", () => {
  it("has the 13 read tools and 18 act tools from Steps 5 and 5b, with no name on both", () => {
    expect(READ_TOOLS).toHaveLength(13);
    expect(ACT_TOOLS).toHaveLength(18);
    for (const t of READ_TOOLS) expect(isActTool(t)).toBe(false);
    for (const t of ACT_TOOLS) expect(isReadTool(t)).toBe(false);
  });

  it("act tools are imported only by src/guards, so every act goes through guardedCall", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name)) files.push(p);
      }
    };
    walk(path.join(process.cwd(), "src"));
    const importers = files
      .filter((f) => /from ["'](@\/tools\/act|\.\/act|\.\.\/tools\/act)["']/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(process.cwd(), f));
    expect(importers.filter((f) => !f.startsWith(path.join("src", "guards")))).toEqual([]);
  });
});
