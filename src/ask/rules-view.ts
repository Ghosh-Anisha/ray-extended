// What the Rules page shows (docs/ui-rebuild.md 3.5): active rules as cards
// with how often each was used, then what RAY suggests. Read only; changes go
// through setRuleStatus and setSetting.
import { and, eq, inArray } from "drizzle-orm";
import type { Adapters } from "@/adapters";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import { AUTO_CUSTOMER_MESSAGES } from "@/guards";
import { dateTime, money } from "@/surfaces/format";
import { isSettingRow, readSettings } from "@/surfaces/playbook";
import { playbookView, type PlaybookView } from "@/surfaces/views";
import { MOMENT_LABEL } from "@/surfaces/words";

export type RuleCardRow = {
  key: string;
  id: string | null;
  sentence: string;
  momentLabel: string;
  limit: string | null;
  on: boolean;
  used: number;
  lastUsed: string | null;
  // How it is switched: a playbook rule, the automatic messages setting, or
  // the approval limit (changed under Settings).
  kind: "rule" | "auto" | "limit";
  moment: s.Moment;
  why: string | null;
};

export type RulesView = { active: RuleCardRow[]; suggested: RuleCardRow[]; settings: PlaybookView };

export function rulesView(a: Adapters, merchantId: string): RulesView {
  const repo = createRepository(a.db);
  const m = repo.merchants.get(merchantId)!;
  const rules = repo.playbookRules.list(eq(s.playbookRules.merchant_id, merchantId));
  const memories = repo.memory.list(and(eq(s.memory.merchant_id, merchantId), eq(s.memory.kind, "pattern")));

  const done = a.db
    .select({ id: s.actions.id, rule: s.actions.approved_by })
    .from(s.actions)
    .where(and(inArray(s.actions.approved_by, rules.map((r) => r.id).concat("-")), eq(s.actions.status, "done")))
    .all();
  const usedBy = new Map<string, string[]>();
  for (const d of done) usedBy.set(d.rule!, [...(usedBy.get(d.rule!) ?? []), d.id]);
  const lastUsed = (ids: string[]) => {
    if (ids.length === 0) return null;
    const at = a.db.select({ at: s.caseEvents.at }).from(s.caseEvents).where(inArray(s.caseEvents.evidence_ref, ids)).all().reduce((hi, e) => Math.max(hi, e.at), 0);
    return at > 0 ? dateTime(at) : null;
  };

  const row = (r: (typeof rules)[number]): RuleCardRow => {
    const ids = usedBy.get(r.id) ?? [];
    const j = r.rule_json;
    const limit = typeof j.max === "number" ? `Up to ${money(j.max)}` : typeof j.min === "number" ? `Above ${money(j.min)}` : typeof j.min_value === "number" ? `Worth more than ${money(j.min_value)}` : typeof j.max_amount === "number" ? `Up to ${money(j.max_amount)}` : null;
    const memory = r.status === "proposed" && r.source === "pattern" ? memories.find((x) => typeof j.tool === "string" && x.vector[j.tool as string] !== undefined) : undefined;
    return {
      key: r.id,
      id: r.id,
      sentence: r.text,
      momentLabel: MOMENT_LABEL[r.moment],
      limit,
      on: r.status === "approved",
      used: ids.length,
      lastUsed: lastUsed(ids),
      kind: "rule",
      moment: r.moment,
      why: memory ? `RAY noticed: ${memory.text}.` : r.source === "pattern" ? "RAY suggests this from how you handle these cases." : null,
    };
  };

  const real = rules.filter((r) => !isSettingRow(r));
  const active = real.filter((r) => r.status !== "proposed").map(row);
  const suggested = real.filter((r) => r.status === "proposed").map(row);

  // Automatic customer messages are a setting, but the merchant switches it
  // like a rule, so it shows with the rules.
  const auto = readSettings(a.db, merchantId, "paid_no_order").autoMessages;
  const autoOn = rules.some((r) => r.rule_json.setting === AUTO_CUSTOMER_MESSAGES && r.status === "approved" && r.rule_json.on === true);
  if (auto || autoOn) {
    active.push({ key: "auto_messages", id: null, sentence: "Message customers automatically when an order is missing after payment", momentLabel: MOMENT_LABEL.paid_no_order, limit: null, on: true, used: 0, lastUsed: null, kind: "auto", moment: "paid_no_order", why: null });
  }
  active.push({
    key: "limit",
    id: null,
    sentence: `Always bring me cases above ${money(m.approval_limit)}`,
    momentLabel: "All moments",
    limit: null,
    on: true,
    used: 0,
    lastUsed: null,
    kind: "limit",
    moment: "paid_no_order",
    why: null,
  });
  return { active, suggested, settings: playbookView(a, merchantId) };
}
