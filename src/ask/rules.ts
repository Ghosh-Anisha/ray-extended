// Rules by chat (docs/ui-rebuild.md 3.4). A deterministic parser turns what
// the merchant typed into a plan; the plan is shown as a rule card; Approve
// rule saves it through the same playbook rows the flows already read. The
// parser never follows anything else in the text, and it never acts: nothing
// changes until the merchant taps Approve rule.
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Adapters } from "@/adapters";
import { newId } from "@/adapters/ids";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import type { Moment } from "@/db/schema";
import { setApprovalLimit, setRuleStatus, setSetting } from "@/surfaces/actions";
import { writeSetting } from "@/surfaces/playbook";
import { MOMENT_LABEL, TONES, type ToneSetting } from "@/surfaces/words";
import { laneRuleId, proposeLanes } from "@/flows/chargebacks/lanes";
import { CAPTURE_RULE_TEXT, proposeSetupRules } from "@/engine/setup-rules";
import { AUTO_CUSTOMER_MESSAGES } from "@/guards";
import { money } from "@/surfaces/format";

export const planSchema = z.discriminatedUnion("intent", [
      z.object({ intent: z.literal("refund_duplicates"), rupees: z.number().int().min(1).max(1_000_000) }),
      z.object({ intent: z.literal("bring_above"), rupees: z.number().int().min(0).max(10_000_000) }),
      z.object({ intent: z.literal("capture") }),
      z.object({ intent: z.literal("call_subscribers"), rupees: z.number().int().min(1).max(10_000_000) }),
      z.object({ intent: z.literal("contest_duplicates") }),
      z.object({ intent: z.literal("auto_messages") }),
      z.object({ intent: z.literal("tone"), tone: z.enum(TONES) }),
  z.object({ intent: z.literal("sign_off"), text: z.string().trim().min(1).max(80) }),
]);
export type RulePlan =
  | { intent: "refund_duplicates"; rupees: number }
  | { intent: "bring_above"; rupees: number }
  | { intent: "capture" }
  | { intent: "call_subscribers"; rupees: number }
  | { intent: "contest_duplicates" }
  | { intent: "auto_messages" }
  | { intent: "tone"; tone: ToneSetting }
  | { intent: "sign_off"; text: string };

// "₹500", "Rs. 2,000", "5k", "1 lakh", "2.5 lakh" -> whole rupees.
export function parseRupees(text: string): number | null {
  const m = text.match(/(?:₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|lakhs?|lacs?|crores?|cr)?\b/i);
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const unit = m[2]?.toLowerCase();
  const mult = !unit ? 1 : unit === "k" || unit === "thousand" ? 1_000 : unit.startsWith("cr") ? 10_000_000 : 100_000;
  const rupees = Math.round(n * mult);
  return rupees > 0 ? rupees : null;
}

// The amount that follows a keyword such as "under", "above", "over".
function amountAfter(text: string, words: RegExp): number | null {
  const m = text.match(new RegExp(`${words.source}\\s*(.*)$`, "i"));
  return m ? parseRupees(m[m.length - 1] ?? "") : null;
}

const has = (t: string, ...res: RegExp[]) => res.every((r) => r.test(t));

export function parseRuleRequest(raw: string): RulePlan | null {
  const t = raw.trim().replace(/\s+/g, " ");
  if (!t || t.length > 300) return null;

  // Tone and sign-off.
  const sign = t.match(/sign(?:ing)?[ -]?off\s+(?:as|with|by)?\s*[:"“']?\s*(.+?)["”']?$/i) ?? t.match(/sign (?:my )?(?:messages|emails)\s+(?:as|with)\s+["“']?(.+?)["”']?$/i);
  if (sign?.[1] && /sign/i.test(t)) return { intent: "sign_off", text: sign[1].replace(/[.!]+$/, "").slice(0, 80) };
  if (/\b(tone|sound|talk|write|messages? to be|be)\b/i.test(t) || /^(use|make it|keep it)\b/i.test(t)) {
    const tone = TONES.find((x) => new RegExp(`\\b${x}\\b`, "i").test(t));
    if (tone && /(tone|sound|talk|write|messages?|use|make|keep|be)/i.test(t) && t.split(" ").length <= 12) return { intent: "tone", tone };
  }

  if (has(t, /\b(contest|fight|dispute)/i, /\b(duplicate|already[- ]refunded|chargebacks?)/i)) return { intent: "contest_duplicates" };
  if (has(t, /\bcapture\b/i, /\b(authori[sz]ed|timeout|time out|before)/i)) return { intent: "capture" };
  if (has(t, /\bcall\b/i, /\b(subscribers?|subscriptions?|members?)\b/i)) {
    const rupees = amountAfter(t, /\b(above|over|more than|worth|greater than|>)/) ?? parseRupees(t);
    return rupees ? { intent: "call_subscribers", rupees } : null;
  }
  if (has(t, /\brefund/i, /\b(duplicate|twice|double|extra)/i) || has(t, /\bduplicate (charges?|payments?)/i)) {
    const rupees = amountAfter(t, /\b(under|below|up to|upto|less than|within|<)/) ?? parseRupees(t);
    return rupees ? { intent: "refund_duplicates", rupees } : null;
  }
  if (has(t, /\b(message|messaging|whatsapp|email|text|write to)\b/i, /\b(customers?|buyers?)\b/i, /\b(automatic|automatically|on its own|by itself|without asking)/i) || has(t, /\bautomatic customer messages?\b/i)) {
    return { intent: "auto_messages" };
  }
  if (
    has(t, /\b(bring|show|send|ask|tell|check with|flag)\b/i, /\b(above|over|more than|greater than|bigger than|>)/i) ||
    has(t, /\bask me (?:first )?before\b/i, /\b(refund|spend|act|anything)/i)
  ) {
    const rupees = amountAfter(t, /\b(above|over|more than|greater than|bigger than|>)/);
    return rupees ? { intent: "bring_above", rupees } : null;
  }
  return null;
}

// ---- The card the merchant sees

export type RuleCardData = {
  plan: RulePlan;
  sentence: string;
  scope: string;
  does: string;
  // The one number the merchant can change before approving.
  edit: { label: string; rupees: number } | null;
  // Already saved and on: nothing to approve.
  alreadyOn: boolean;
};

// "Under ₹500" includes every paise below ₹500, but excludes ₹500 exactly.
export const underPaise = (rupees: number) => rupees * 100 - 1;

const LEAFY_SCOPE = (a: Adapters, merchantId: string) => createRepository(a.db).merchants.get(merchantId)?.name ?? "Your account";

export function describePlan(a: Adapters, merchantId: string, plan: RulePlan): RuleCardData {
  const who = LEAFY_SCOPE(a, merchantId);
  const base = { plan, edit: null as RuleCardData["edit"], alreadyOn: false };
  switch (plan.intent) {
    case "refund_duplicates":
      return {
        ...base,
        sentence: `Refund duplicate charges under ${money(plan.rupees * 100)} automatically`,
        scope: `${who} · Charged twice · under ${money(plan.rupees * 100)}`,
        does: "When a customer is charged twice for one order, RAY refunds the extra payment without asking you, and tells the customer. Anything above this amount still comes to you.",
        edit: { label: "Refund under", rupees: plan.rupees },
        alreadyOn: isOn(a, merchantId, "paid_no_order", (j) => j.tool === "refund" && j.when === "duplicate" && j.max === underPaise(plan.rupees)),
      };
    case "bring_above":
      return {
        ...base,
        sentence: `Always bring me cases above ${money(plan.rupees * 100)}`,
        scope: `${who} · All moments · above ${money(plan.rupees * 100)}`,
        does: `RAY won't move money on a case above ${money(plan.rupees * 100)} until you tap. Below it, RAY still follows your other rules.`,
        edit: { label: "Bring me cases above", rupees: plan.rupees },
        alreadyOn: createRepository(a.db).merchants.get(merchantId)?.approval_limit === plan.rupees * 100,
      };
    case "capture":
      return {
        ...base,
        sentence: CAPTURE_RULE_TEXT,
        scope: `${who} · ${MOMENT_LABEL.paid_no_order} · authorised payments`,
        does: "When a payment is authorised but not captured, RAY captures it before Razorpay's 5 day timeout would refund it to the customer.",
        alreadyOn: isOn(a, merchantId, "paid_no_order", (j) => j.tool === "capture"),
      };
    case "call_subscribers":
      return {
        ...base,
        sentence: `Call subscribers worth more than ${money(plan.rupees * 100)}`,
        scope: `${who} · ${MOMENT_LABEL.subscription} · lifetime value above ${money(plan.rupees * 100)}`,
        does: "When a subscriber who has paid you more than this is about to leave, RAY calls them within your calling hours, only if they agreed to calls. Everyone else gets a message.",
        edit: { label: "Call subscribers worth more than", rupees: plan.rupees },
        alreadyOn: isOn(a, merchantId, "subscription", (j) => j.tool === "place_call" && j.min_value === plan.rupees * 100),
      };
    case "contest_duplicates":
      return {
        ...base,
        sentence: "Contest duplicate and already-refunded chargebacks without asking",
        scope: `${who} · ${MOMENT_LABEL.chargeback} · first stage only`,
        does: "RAY contests a chargeback when the customer was charged twice or you already refunded it. You get a 2-hour Stop window first, and RAY never contests a fraud claim on its own.",
        alreadyOn: createRepository(a.db).playbookRules.get(laneRuleId(merchantId, "contest"))?.status === "approved",
      };
    case "auto_messages":
      return {
        ...base,
        sentence: "Message customers automatically when an order is missing after payment",
        scope: `${who} · ${MOMENT_LABEL.paid_no_order} · customer messages`,
        does: "RAY sends the customer the update itself, with checkable details and no link, and puts a copy on the case. Refunds and anything with money still need your tap.",
        alreadyOn: readAuto(a, merchantId),
      };
    case "tone":
      return { ...base, sentence: `Write to customers in a ${plan.tone.toLowerCase()} tone`, scope: `${who} · All moments · tone`, does: `Every customer message RAY writes will sound ${plan.tone.toLowerCase()}. Numbers and facts stay the same.` };
    case "sign_off":
      return { ...base, sentence: `Sign off customer messages as "${plan.text}"`, scope: `${who} · All moments · sign-off`, does: "RAY ends every customer message with this line." };
  }
}

type Json = Record<string, unknown>;
function isOn(a: Adapters, merchantId: string, moment: Moment, match: (j: Json) => boolean) {
  return createRepository(a.db)
    .playbookRules.list(and(eq(s.playbookRules.merchant_id, merchantId), eq(s.playbookRules.moment, moment), eq(s.playbookRules.status, "approved")))
    .some((r) => typeof r.rule_json.setting !== "string" && match(r.rule_json));
}
function readAuto(a: Adapters, merchantId: string) {
  return createRepository(a.db)
    .playbookRules.list(and(eq(s.playbookRules.merchant_id, merchantId), eq(s.playbookRules.moment, "paid_no_order"), eq(s.playbookRules.status, "approved")))
    .some((r) => r.rule_json.setting === AUTO_CUSTOMER_MESSAGES && r.rule_json.on === true);
}

// ---- Saving: Approve rule

// Saves a rule of this kind with this amount, replacing an older rule of the
// same kind so there is one rule per kind and moment. Returns the rule id.
function saveRule(a: Adapters, merchantId: string, moment: Moment, rule_json: Json, text: string, same: (j: Json) => boolean): string {
  const repo = createRepository(a.db);
  const existing = repo.playbookRules.list(and(eq(s.playbookRules.merchant_id, merchantId), eq(s.playbookRules.moment, moment))).find((r) => typeof r.rule_json.setting !== "string" && same(r.rule_json));
  if (existing) {
    if (!repo.playbookRules.update(existing.id, { rule_json, text, status: "approved", approved_at: a.clock.now() })) {
      throw new Error("The rule could not be saved. It remains off.");
    }
    return verifySavedRule(repo, existing.id, merchantId, moment, same);
  }
  const id = newId("rule");
  if (!repo.playbookRules.insert({ id, merchant_id: merchantId, moment, rule_json, text, source: "merchant", status: "approved", approved_at: a.clock.now() })) {
    throw new Error("The rule could not be saved. It remains off.");
  }
  return verifySavedRule(repo, id, merchantId, moment, same);
}

function verifySavedRule(repo: ReturnType<typeof createRepository>, id: string, merchantId: string, moment: Moment, same: (j: Json) => boolean) {
  const saved = repo.playbookRules.get(id);
  if (!saved || saved.merchant_id !== merchantId || saved.moment !== moment || saved.status !== "approved" || !same(saved.rule_json)) {
    throw new Error("The rule was not confirmed in saved Active rules. It remains off until saving succeeds.");
  }
  return id;
}

export function applyPlan(a: Adapters, merchantId: string, plan: RulePlan): { text: string } {
  const repo = createRepository(a.db);
  switch (plan.intent) {
    case "refund_duplicates":
      saveRule(a, merchantId, "paid_no_order", { tool: "refund", when: "duplicate", max: underPaise(plan.rupees) }, `Refund duplicate charges under ${money(plan.rupees * 100)} automatically`, (j) => j.tool === "refund" && j.when === "duplicate");
      return { text: `Rule is on. RAY will refund duplicate charges under ${money(plan.rupees * 100)} without asking.` };
    case "bring_above":
      setApprovalLimit(a, { merchantId, rupees: plan.rupees });
      return { text: `Done. RAY will bring you every case above ${money(plan.rupees * 100)}.` };
    case "capture": {
      proposeSetupRules(a.db, merchantId);
      const id = `rule_setup_capture_${merchantId}`;
      if (!repo.playbookRules.get(id)) throw new Error("The capture rule isn't available for this account");
      setRuleStatus(a, { merchantId, ruleId: id, status: "approved" });
      return { text: "Rule is on. RAY will capture authorised payments before the timeout." };
    }
    case "call_subscribers":
      saveRule(a, merchantId, "subscription", { tool: "place_call", kind: "subscription_save", min_value: plan.rupees * 100 }, `Call subscribers worth more than ${money(plan.rupees * 100)}`, (j) => j.tool === "place_call" && j.kind === "subscription_save");
      return { text: `Rule is on. RAY will call subscribers worth more than ${money(plan.rupees * 100)}, inside your calling hours.` };
    case "contest_duplicates": {
      proposeLanes(a.db, merchantId);
      setRuleStatus(a, { merchantId, ruleId: laneRuleId(merchantId, "contest"), status: "approved" });
      return { text: "Rule is on. RAY will contest duplicate and already-refunded chargebacks, with a 2-hour Stop window first." };
    }
    case "auto_messages":
      setSetting(a, { merchantId, moment: "paid_no_order", key: AUTO_CUSTOMER_MESSAGES, value: true });
      return { text: "Rule is on. RAY will message customers itself when an order is missing after payment." };
    case "tone":
      for (const m of s.MOMENTS) writeSetting(a.db, a.clock.now(), merchantId, m, "tone", plan.tone);
      return { text: `Saved. Customer messages will sound ${plan.tone.toLowerCase()}.` };
    case "sign_off":
      for (const m of s.MOMENTS) writeSetting(a.db, a.clock.now(), merchantId, m, "sign_off", plan.text);
      return { text: `Saved. Customer messages will end with "${plan.text}".` };
  }
}
