// PLACEHOLDER until Step 5. The read tools investigate may call. Step 5
// builds the real ones in src/tools and replaces this file's list with
// theirs, so there is only ever one list. Anything not on it (refund,
// send_message, every act tool) is refused by the investigate loop.
import { and, eq } from "drizzle-orm";
import type { Repository } from "@/db/repository";
import * as s from "@/db/schema";

export const READ_TOOLS = [
  "get_payment",
  "get_order",
  "list_order_payments",
  "get_refunds",
  "get_webhook_deliveries",
  "get_plugin_reports",
  "get_store_order",
  "get_store_settings",
  "get_downtimes",
  "get_dispute",
  "get_subscription",
  "get_invoices",
  "get_bank_credits",
] as const;
export type ReadToolName = (typeof READ_TOOLS)[number];

export const isReadTool = (name: string): name is ReadToolName => (READ_TOOLS as readonly string[]).includes(name);

// evidence_ids are the source records a finding may cite.
export type ReadToolResult = { evidence_ids: string[]; data: unknown };
export type ReadToolRunner = (tool: ReadToolName, id: string | null) => Promise<ReadToolResult>;

// A few placeholder reads straight from the database, enough to exercise the
// loop. The rest say they aren't built yet.
export function placeholderReadTools(repo: Repository, merchantId: string): ReadToolRunner {
  return async (tool, id) => {
    switch (tool) {
      case "get_payment": {
        const p = id ? repo.rzpPayments.get(id) : undefined;
        return p && p.merchant_id === merchantId ? { evidence_ids: [p.id], data: p } : { evidence_ids: [], data: null };
      }
      case "get_store_order": {
        const o = id ? repo.storeOrders.get(id) : undefined;
        return o && o.merchant_id === merchantId ? { evidence_ids: [o.id], data: o } : { evidence_ids: [], data: null };
      }
      case "get_webhook_deliveries": {
        const rows = id
          ? repo.webhookDeliveries.list(
              and(eq(s.webhookDeliveries.merchant_id, merchantId), eq(s.webhookDeliveries.payment_id, id)),
            )
          : [];
        return { evidence_ids: rows.map((r) => r.event_id), data: rows };
      }
      case "get_store_settings": {
        const row = repo.storeSettings.get(merchantId);
        return { evidence_ids: row ? [`store_settings:${merchantId}`] : [], data: row ?? null };
      }
      default:
        return { evidence_ids: [], data: { unavailable: `${tool} is built in Step 5` } };
    }
  };
}
