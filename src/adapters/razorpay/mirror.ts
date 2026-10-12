// Keeps the rzp_payments mirror in step with Razorpay before a check reads
// it. Razorpay can only list payments by time, so this lists the last 72
// hours and keeps the ones from the same contact or email (filtered in code).
// In mock mode the list comes from the mirror itself, so the same code runs
// and nothing changes; in test mode it adds the payments the mirror lacks,
// such as one made through a pay-again link on a different order.
import type { Db } from "@/db/client";
import { createRepository } from "@/db/repository";
import { normalizeEmail, normalizePhone } from "@/engine/events";
import type { Payment, RazorpayAdapter } from "./types";

export const MIRROR_SYNC_WINDOW_MS = 72 * 60 * 60 * 1000;

export const sameContact = (p: Pick<Payment, "contact" | "email">, who: { contact?: string | null; email?: string | null }) => {
  const phone = normalizePhone(who.contact);
  const email = normalizeEmail(who.email);
  return (!!phone && normalizePhone(p.contact) === phone) || (!!email && normalizeEmail(p.email) === email);
};

export async function syncRecentPayments(
  db: Db,
  rzp: RazorpayAdapter,
  merchantId: string,
  input: { now: number; contact?: string | null; email?: string | null },
): Promise<Payment[]> {
  const repo = createRepository(db);
  const recent = (await rzp.listPayments({ from: input.now - MIRROR_SYNC_WINDOW_MS, to: input.now })).filter((p) =>
    sameContact(p, input),
  );
  for (const p of recent) {
    // The mirror's order_id must point at a mirrored order.
    if (p.order_id && !repo.rzpOrders.get(p.order_id)) {
      const o = await rzp.fetchOrder(p.order_id);
      repo.rzpOrders.insert({ id: o.id, merchant_id: merchantId, status: o.status, amount: o.amount, currency: o.currency, receipt: o.receipt, created_at: o.created_at });
    }
    const row = {
      merchant_id: merchantId,
      order_id: p.order_id,
      status: p.status,
      amount: p.amount,
      currency: p.currency,
      base_amount: p.base_amount,
      method: p.method,
      contact: p.contact,
      email: p.email,
      vpa: p.vpa,
      card_last4: p.card_last4,
      card_country: p.card_country,
      utr: p.utr,
      error_code: p.error_code,
      error_source: p.error_source,
      error_reason: p.error_reason,
      created_at: p.created_at,
      captured_at: p.captured_at,
    };
    if (repo.rzpPayments.get(p.id)) repo.rzpPayments.update(p.id, { status: p.status, captured_at: p.captured_at });
    else repo.rzpPayments.insert({ id: p.id, ...row });
  }
  return recent;
}
