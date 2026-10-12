// Whether an act tool, with these args, runs alone: no tap and no rule
// needed (send_message by kind, payment_link, pay_pending_invoice, drafts).
// Read only, for the orchestrator's runs-alone path (Step 9). The kinds
// that still check something (automatic customer messages) never count.
import { ACT_TOOL_SPECS, needsApproval } from "@/tools/act";
import { isActTool } from "@/tools/names";

export function runsAlone(tool: string, args: Record<string, unknown>): boolean {
  if (!isActTool(tool)) return false;
  if (tool === "send_message" && args.kind === "auto_customer") return false;
  const spec = ACT_TOOL_SPECS[tool];
  const parsed = spec.args.safeParse(args);
  return parsed.success && needsApproval(spec, parsed.data) === "none";
}
