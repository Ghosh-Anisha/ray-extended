// The pattern check. When card payments from abroad keep failing the same
// way (three or more in 7 days with one cause), RAY turns them into one
// insight with the ₹ at stake and the trade-off of the setting that would
// help. The model writes the insight text; code picks the cause, the count,
// the amount and the setting. The setting change is a proposed playbook
// rule with tool "none" (it can never approve an action) and nothing
// changes until the merchant taps Approve rule.
import { and, eq, gte } from "drizzle-orm";
import { newId } from "@/adapters/ids";
import type { Ai } from "@/ai";
import * as s from "@/db/schema";
import type { EngineContext } from "@/engine/specialist";
import type { Case } from "@/engine/state-machine";
import { formatMoney } from "@/guards/format";
import { idAliases } from "../shared/stable-ids";
import type { Cause } from "./errors";
import type { IntlSettingKey, InternationalSim } from "./sim";

export const INSIGHT_MIN = 3;
export const INSIGHT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const INSIGHT_ALERT = "intl_insight";

type Change = { key: IntlSettingKey; value: boolean | number; text: string; tradeOff: string };

// What the failures have in common, as the merchant reads it.
const PATTERN: Partial<Record<Cause, string>> = {
  three_ds_failed: "the card security check (3DS) didn't go through",
  three_ds_timed_out: "the card security check (3DS) didn't go through",
  bank_declined: "the buyer's bank declined the card",
  bank_declined_fraud: "the buyer's bank declined the card",
  card_not_international: "the card wasn't turned on for payments abroad",
  card_not_online: "the card wasn't turned on for payments abroad",
  above_limit: "the payment was above your international limit",
};

// The cause each one counts with (3DS failed and timed out are one pattern).
const GROUP: Partial<Record<Cause, Cause>> = { three_ds_timed_out: "three_ds_failed", bank_declined_fraud: "bank_declined", card_not_online: "card_not_international" };
export const patternOf = (cause: Cause): Cause => GROUP[cause] ?? cause;

const LAKH = 100_000 * 100;

function changeFor(cause: Cause, sim: InternationalSim, merchantId: string, largestInr: number): Change | null {
  const st = sim.settings(merchantId);
  if (!st) return null;
  const paypal: Change | null =
    !st.paypal_on && st.checkout === "standard"
      ? { key: "paypal_on", value: true, text: "Turn on PayPal for buyers abroad", tradeOff: "Buyers who pick PayPal leave your checkout to pay on PayPal." }
      : null;
  switch (patternOf(cause)) {
    case "three_ds_failed":
      return st.non_3ds
        ? paypal
        : { key: "non_3ds", value: true, text: "Take cards from abroad without the security check (3DS)", tradeOff: "Without 3DS, you carry fraud chargebacks on these payments." };
    case "bank_declined":
    case "card_not_international":
      return paypal;
    case "above_limit": {
      const to = Math.ceil(largestInr / LAKH) * LAKH;
      if (to <= st.limit_inr) return null;
      return { key: "limit_inr", value: to, text: `Raise your international limit to ${formatMoney(to)}`, tradeOff: "A higher limit means a bigger single payment at risk if a card turns out to be stolen." };
    }
    default:
      return null;
  }
}

export async function patternCheck(ctx: EngineContext, kase: Case, cause: Cause, deps: { ai: Ai; sim: InternationalSim; evidenceRef: string }) {
  const pattern = patternOf(cause);
  if (!PATTERN[pattern]) return null;
  const since = ctx.clock.now() - INSIGHT_WINDOW_MS;
  const same = ctx.repo.cases
    .list(and(eq(s.cases.merchant_id, kase.merchant_id), eq(s.cases.moment, "international"), gte(s.cases.opened_at, since)))
    .filter((c) => c.cause && patternOf(c.cause as Cause) === pattern);
  if (same.length < INSIGHT_MIN) return null;
  // One insight per pattern per 7 days.
  const told = ctx.repo.alerts
    .list(and(eq(s.alerts.merchant_id, kase.merchant_id), eq(s.alerts.kind, INSIGHT_ALERT), gte(s.alerts.sent_at, since)))
    .some((x) => x.text.includes(PATTERN[pattern]!) || ctx.repo.caseEvents.listByCase(x.case_id ?? "").some((e) => e.payload.kind === "intl_insight" && e.payload.pattern === pattern));
  if (told) return null;

  const payments = same.map((c) => (c.payment_id ? ctx.repo.rzpPayments.get(c.payment_id) : undefined)).filter((p) => !!p);
  const atStake = payments.reduce((n, p) => n + (p.currency === "INR" ? p.amount : (p.base_amount ?? 0)), 0);
  const largest = Math.max(0, ...payments.map((p) => (p.currency === "INR" ? p.amount : (p.base_amount ?? 0))));
  const change = changeFor(cause, deps.sim, kase.merchant_id, largest);
  const merchant = ctx.repo.merchants.get(kase.merchant_id)!;
  const facts = {
    merchant: merchant.name,
    failures: same.length,
    days: 7,
    what_they_share: PATTERN[pattern],
    at_stake: formatMoney(atStake),
    setting_change: change?.text ?? null,
    trade_off: change?.tradeOff ?? null,
  };
  const fallback = `${same.length} card payments from abroad failed in the last 7 days the same way: ${PATTERN[pattern]}. ${formatMoney(atStake)} at stake.${change ? ` ${change.text}? ${change.tradeOff}` : ""}`;
  const ids = idAliases();
  const r = await deps.ai.write({ audience: "merchant", kind: "intl_insight", first_customer_message: false, facts: ids.hide(facts), tone: "Plain", language: "en" }, { caseId: kase.id });
  const text = r.source !== "fallback" && r.output.draft ? ids.show(r.output.draft) : fallback;

  const now = ctx.clock.now();
  const alert = ctx.repo.alerts.insert({ id: newId("alert"), merchant_id: kase.merchant_id, case_id: kase.id, kind: INSIGHT_ALERT, text, channel: "in_app", sent_at: now });
  const rule = change
    ? ctx.repo.playbookRules.insert({
        id: newId("rule"),
        merchant_id: kase.merchant_id,
        moment: "international",
        rule_json: { intl_setting: change.key, value: change.value, tool: "none", pattern },
        text: change.text,
        source: "pattern",
        status: "proposed",
        approved_at: null,
      })
    : null;
  ctx.repo.caseEvents.insert({
    id: newId("cev"),
    case_id: kase.id,
    at: now,
    type: "note",
    payload: { kind: "intl_insight", pattern, text, failures: same.length, at_stake: atStake, alert_id: alert.id, rule_id: rule?.id ?? null, case_ids: same.map((c) => c.id) },
    evidence_ref: deps.evidenceRef,
  });
  return { text, alert, rule, failures: same.length, atStake };
}
