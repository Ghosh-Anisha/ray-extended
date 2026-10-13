// Seed for Step 8 (card declined abroad). Only this flow's own tables:
// rows in the shared tables (Emma, Oliver, their failed payments) come from
// the main seed. All fictional; bank details are made up.
import type { Db } from "../client";
import { intlAccounts, intlPaymentSignals, intlSettings } from "@/flows/international/schema";

const LAKH = 100_000 * 100; // INR paise

export function seedInternational(db: Db, now: number) {
  db.insert(intlSettings)
    .values([
      // NoteNest sells a B2C app abroad on Standard Checkout, with PayPal.
      {
        merchant_id: "m_notenest", international_on: true, limit_inr: 5 * LAKH, currencies: ["USD", "EUR", "GBP"], networks: ["visa", "mastercard"],
        checkout: "standard", paypal_on: true, moneysaver_on: false, billing_address_required: false, buyer_type: null, updated_at: now,
      },
      // PixelForge invoices agencies abroad: a ₹2 lakh limit, no PayPal, MoneySaver for transfers.
      {
        merchant_id: "m_pixelforge", international_on: true, limit_inr: 2 * LAKH, currencies: ["GBP", "USD", "EUR"], networks: ["visa", "mastercard"],
        checkout: "standard", paypal_on: false, moneysaver_on: true, billing_address_required: false, buyer_type: null, updated_at: now,
      },
    ])
    .run();
  db.insert(intlAccounts)
    .values([
      {
        id: "msa_PF_gbp", merchant_id: "m_pixelforge", currency: "GBP", bank_name: "MoneySaver UK partner bank", account_name: "PixelForge Studio",
        account_number: "41207788", routing_label: "Sort code", routing: "20-45-77", swift: "MSVRGB2L",
      },
      {
        id: "msa_PF_usd", merchant_id: "m_pixelforge", currency: "USD", bank_name: "MoneySaver US partner bank", account_name: "PixelForge Studio",
        account_number: "880031274", routing_label: "Routing number", routing: "026073150", swift: "MSVRUS33",
      },
    ])
    .run();
  // What Razorpay's own systems said about the seeded failed payments.
  db.insert(intlPaymentSignals)
    .values([
      { payment_id: "pay_NN_emma_failed", merchant_id: "m_notenest", vulcan_result: "clean", risk_hold: "none", three_ds: null, updated_at: now },
      { payment_id: "pay_PF_oliver_failed", merchant_id: "m_pixelforge", vulcan_result: "clean", risk_hold: "none", three_ds: "passed", updated_at: now },
    ])
    .run();
}
