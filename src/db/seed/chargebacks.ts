// Seed for Step 10 (chargebacks). Only the flow's own tables, so the main
// seed's row counts stay as they are. All people are fictional.
// - Leafy Bakes files dispute replies through Razorpay's Disputes API.
// - Meera has an open Buyer Protection claim on her ₹6,900 payment
//   (Simulated); it is evidence for her pack.
// Leafy Bakes' lanes are not seeded: RAY proposes them on the first
// chargeback and the merchant switches each one on.
import type { Db } from "../client";
import { cbBuyerProtectionClaims, cbSettings } from "@/flows/chargebacks/schema";

const DAY = 24 * 60 * 60 * 1000;

export function seedChargebacks(db: Db, now: number) {
  db.insert(cbSettings).values({ merchant_id: "m_leafy_bakes", filing: "disputes_api", updated_at: now - 30 * DAY }).run();
  db.insert(cbBuyerProtectionClaims)
    .values({
      id: "bpc_LB_meera",
      merchant_id: "m_leafy_bakes",
      payment_id: "pay_LB1198MEERA",
      status: "open",
      summary: "Customer says the party cake never arrived",
      opened_at: now - 3 * DAY,
    })
    .run();
}
