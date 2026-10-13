// The one list of tool names. Read tools only look; act tools change
// something and only ever run through guardedCall in src/guards.
// investigate's prompt and fixture keys carry READ_TOOLS, so keep its order.

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

export const ACT_TOOLS = [
  "mark_paid",
  "restore_order",
  "create_order_for_payment",
  "cancel_order",
  "refund",
  "capture",
  "payment_link",
  "send_message",
  "attach_dispute_proof",
  "contest_dispute",
  "accept_dispute",
  "pay_pending_invoice",
  "pause_subscription",
  "resume_subscription",
  "cancel_subscription",
  "post_match",
  "draft_request",
  "place_call",
  // Step 9: links the merchant's Dashboard offer to a live subscription.
  "apply_offer",
] as const;
export type ActToolName = (typeof ACT_TOOLS)[number];

export const isReadTool = (name: string): name is ReadToolName => (READ_TOOLS as readonly string[]).includes(name);
export const isActTool = (name: string): name is ActToolName => (ACT_TOOLS as readonly string[]).includes(name);

// evidence_ids are the source records a finding may cite.
export type ReadToolResult = { evidence_ids: string[]; data: unknown };
export type ReadToolRunner = (tool: ReadToolName, id: string | null) => Promise<ReadToolResult>;
