// The simulated Razorpay systems this flow reads, behind one adapter. All
// state is in the database (rule 11):
// - international settings per account (limit, currencies, networks,
//   checkout kind, PayPal, MoneySaver), overlaid by any pattern rule the
//   merchant approved (a setting change needs approval);
// - the signals Razorpay's own systems set on a payment (Vulcan, risk hold,
//   3DS). RAY reads them and never re-scores them;
// - MoneySaver receiving accounts and the transfers landing in them;
// - settlement of a transfer: held until an invoice is attached, read from
//   the guarded invoice_attach action;
// - the risk desk: review tickets are guarded risk_review actions.
import { and, eq } from "drizzle-orm";
import type { Clock } from "@/adapters/clock";
import { newId } from "@/adapters/ids";
import type { Db } from "@/db/client";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import { intlAccounts, intlPaymentSignals, intlSettings, intlTransfers } from "./schema";

export type IntlSettings = typeof intlSettings.$inferSelect & { non_3ds: boolean };
export type Signals = typeof intlPaymentSignals.$inferSelect;
export type MoneySaverAccount = typeof intlAccounts.$inferSelect;
export type Transfer = typeof intlTransfers.$inferSelect;

// Simulated conversion to INR, in paise per minor unit, rounded to whole
// rupees: $49 is ₹4,100 and £2,800 is ₹3.1 lakh, as in the seed.
export const FX_TO_INR: Record<string, number> = { INR: 1, USD: 410_000 / 4_900, GBP: 31_000_000 / 280_000, EUR: 90.5 };
export function toInr(amount: number, currency: string): number | null {
  const rate = FX_TO_INR[currency];
  return rate === undefined ? null : Math.round((amount * rate) / 100) * 100;
}

// A setting change the merchant approved from a pattern insight. rule_json:
// { intl_setting, value, tool: "none" } so it can never approve an action.
export const INTL_SETTING_KEYS = ["paypal_on", "non_3ds", "limit_inr"] as const;
export type IntlSettingKey = (typeof INTL_SETTING_KEYS)[number];

export const REQUEST_KINDS = { risk: "risk_review", invoice: "invoice_attach" } as const;

export function createInternationalSim(db: Db, clock: Clock) {
  const repo = createRepository(db);

  function approvedChanges(merchantId: string) {
    return repo.playbookRules
      .list(and(eq(s.playbookRules.merchant_id, merchantId), eq(s.playbookRules.moment, "international"), eq(s.playbookRules.status, "approved")))
      .filter((r) => typeof r.rule_json.intl_setting === "string");
  }

  const sim = {
    settings(merchantId: string): IntlSettings | null {
      const row = db.select().from(intlSettings).where(eq(intlSettings.merchant_id, merchantId)).get();
      if (!row) return null;
      const out: IntlSettings = { ...row, non_3ds: false };
      for (const r of approvedChanges(merchantId)) {
        const key = r.rule_json.intl_setting as IntlSettingKey;
        if (key === "paypal_on" || key === "non_3ds") out[key] = r.rule_json.value === true;
        if (key === "limit_inr" && typeof r.rule_json.value === "number") out.limit_inr = Math.max(out.limit_inr, r.rule_json.value);
      }
      return out;
    },

    // Razorpay changed the account (the merchant's request went through).
    updateSettings(merchantId: string, patch: Partial<Omit<typeof intlSettings.$inferInsert, "merchant_id">>) {
      return db.update(intlSettings).set({ ...patch, updated_at: clock.now() }).where(eq(intlSettings.merchant_id, merchantId)).returning().get();
    },

    // PayPal only on Standard Checkout, only for non-INR.
    paypalAvailable(merchantId: string, currency: string) {
      const st = sim.settings(merchantId);
      return !!st && st.paypal_on && st.checkout === "standard" && currency !== "INR";
    },

    signals(paymentId: string): Signals | null {
      return db.select().from(intlPaymentSignals).where(eq(intlPaymentSignals.payment_id, paymentId)).get() ?? null;
    },

    // Only Razorpay's systems set these (the simulator stands in for them).
    setSignals(merchantId: string, paymentId: string, patch: Partial<Pick<Signals, "vulcan_result" | "risk_hold" | "three_ds">>) {
      const now = clock.now();
      const have = sim.signals(paymentId);
      if (have) return db.update(intlPaymentSignals).set({ ...patch, updated_at: now }).where(eq(intlPaymentSignals.payment_id, paymentId)).returning().get();
      return db
        .insert(intlPaymentSignals)
        .values({ payment_id: paymentId, merchant_id: merchantId, vulcan_result: "clean", risk_hold: "none", three_ds: null, ...patch, updated_at: now })
        .returning()
        .get();
    },

    account(merchantId: string, currency: string): MoneySaverAccount | null {
      const st = sim.settings(merchantId);
      if (!st?.moneysaver_on) return null;
      return db.select().from(intlAccounts).where(and(eq(intlAccounts.merchant_id, merchantId), eq(intlAccounts.currency, currency))).get() ?? null;
    },

    accountById(id: string) {
      return db.select().from(intlAccounts).where(eq(intlAccounts.id, id)).get() ?? null;
    },

    transfer(id: string): Transfer | null {
      return db.select().from(intlTransfers).where(eq(intlTransfers.id, id)).get() ?? null;
    },

    transfers(merchantId: string): Transfer[] {
      return db.select().from(intlTransfers).where(eq(intlTransfers.merchant_id, merchantId)).all();
    },

    // A bank transfer lands in a MoneySaver account.
    landTransfer(input: { merchantId: string; currency: string; amount: number; remitterName: string; remitterReference: string; invoiceRef?: string | null }): Transfer {
      const acc = sim.account(input.merchantId, input.currency);
      if (!acc) throw new Error(`No MoneySaver ${input.currency} account for ${input.merchantId}`);
      return db
        .insert(intlTransfers)
        .values({
          id: newId("trf"),
          merchant_id: input.merchantId,
          account_id: acc.id,
          currency: input.currency,
          amount: input.amount,
          base_amount: toInr(input.amount, input.currency) ?? 0,
          remitter_name: input.remitterName,
          remitter_reference: input.remitterReference,
          invoice_ref: input.invoiceRef ?? null,
          received_at: clock.now(),
        })
        .returning()
        .get();
    },

    // The done invoice_attach action for a transfer, if any.
    invoiceAttach(transferId: string) {
      return requestActions(db, REQUEST_KINDS.invoice).find((x) => (x.args.evidence_refs as string[] | undefined)?.includes(transferId)) ?? null;
    },

    // Held until an invoice is attached (by the buyer's bank, or by RAY).
    settlement(transferId: string): "held" | "released" {
      const t = sim.transfer(transferId);
      if (!t) throw new Error(`Transfer ${transferId} not found`);
      return t.invoice_ref || sim.invoiceAttach(transferId) ? "released" : "held";
    },

    // Review tickets on Razorpay's risk desk.
    riskTickets(merchantId: string) {
      return requestActions(db, REQUEST_KINDS.risk).filter((x) => repo.cases.get(x.case_id)?.merchant_id === merchantId);
    },
  };
  return sim;
}
export type InternationalSim = ReturnType<typeof createInternationalSim>;

function requestActions(db: Db, request: string) {
  return createRepository(db)
    .actions.list(and(eq(s.actions.tool, "draft_request"), eq(s.actions.status, "done")))
    .filter((x) => x.args.request === request);
}
