// Seed data from docs/build-guide.html, Step 1. All merchants, customers and
// buyers are fictional; emails use example.com and phones are made up.
// Only starting state is seeded: cases, events, actions, timers and messages
// are created later by the engine from events. Rules are only the ones RAY
// proposes at setup, each off until the merchant approves it.
import { pathToFileURL } from "node:url";
import { openMigratedDb, type Db } from "./client";
import { proposeSetupRules } from "@/engine/setup-rules";
import { seedChargebacks } from "./seed/chargebacks";
import { seedCollect } from "./seed/collect";
import { createRepository } from "./repository";
import { seedInternational } from "./seed/international";
import { seedSubscriptions } from "./seed/subscriptions";
import type * as s from "./schema";

export const SEED_NOW = Date.parse("2026-10-12T10:00:00+05:30");
// The demo world starts here (docs/ui-rebuild.md section 4): Tue 13 Oct 2026, 10:00 AM IST.
export const DEMO_NOW = Date.parse("2026-10-13T10:00:00+05:30");

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const rupees = (r: number) => Math.round(r * 100); // to paise
const LAKH = 100_000;

type NewMerchant = typeof s.merchants.$inferInsert;

function merchant(
  m: Omit<NewMerchant, "cluster" | "kill_switch"> & Partial<Pick<NewMerchant, "kill_switch">>,
): NewMerchant {
  return { ...m, cluster: [m.store_platform, m.gmv_band, m.risk_band, m.failure_history].join("|") };
}

const MERCHANTS: NewMerchant[] = [
  merchant({
    id: "m_leafy_bakes", name: "Leafy Bakes", business_type: "home bakery", store_platform: "woocommerce",
    gmv_band: "small", risk_band: "low", failure_history: "high", wave: 1, ray_on: true, connector_on: true,
    // The seeded buyer, invoice and consent records support the simulated
    // Dues → Collect demo. This flag enables that demo workflow only; no live
    // Banking+ integration or payment rail is connected.
    whatsapp_on: true, banking_plus: true, udyam: false, approval_limit: rupees(2_000),
    // Opted in to the urgent call before a chargeback deadline (Step 10).
    urgent_call_opt_in: true,
  }),
  merchant({
    id: "m_notenest", name: "NoteNest", business_type: "saas_b2c", store_platform: "custom",
    gmv_band: "small", risk_band: "low", failure_history: "low", wave: 1, ray_on: true, connector_on: false,
    whatsapp_on: false, banking_plus: false, udyam: false, approval_limit: rupees(5_000),
  }),
  merchant({
    id: "m_pixelforge", name: "PixelForge Studio", business_type: "agency_b2b", store_platform: "custom",
    gmv_band: "medium", risk_band: "medium", failure_history: "low", wave: 2, ray_on: true, connector_on: false,
    whatsapp_on: true, banking_plus: false, udyam: false, approval_limit: rupees(10_000),
  }),
  merchant({
    id: "m_fitloop", name: "FitLoop", business_type: "fitness app", store_platform: "app",
    gmv_band: "small", risk_band: "low", failure_history: "medium", wave: 1, ray_on: true, connector_on: false,
    whatsapp_on: true, banking_plus: false, udyam: false, approval_limit: rupees(1_000),
  }),
  merchant({
    id: "m_stackly", name: "Stackly", business_type: "saas_b2b", store_platform: "custom",
    gmv_band: "medium", risk_band: "low", failure_history: "low", wave: 1, ray_on: true, connector_on: false,
    whatsapp_on: false, banking_plus: false, udyam: false, approval_limit: rupees(25_000),
  }),
  merchant({
    id: "m_sharma_tutorials", name: "Sharma Tutorials", business_type: "tuition", store_platform: "none",
    gmv_band: "small", risk_band: "low", failure_history: "low", wave: 2, ray_on: true, connector_on: false,
    whatsapp_on: true, banking_plus: false, udyam: false, approval_limit: rupees(3_000),
  }),
  merchant({
    id: "m_packright", name: "PackRight", business_type: "packaging manufacturer, Ludhiana",
    store_platform: "none", gmv_band: "medium", risk_band: "low", failure_history: "medium", wave: 1,
    ray_on: true, connector_on: false, whatsapp_on: true, banking_plus: true, udyam: true,
    approval_limit: rupees(50_000),
  }),
  // Alert-only comparison merchants: RAY off, same clusters as above.
  merchant({
    id: "m_crumb_co", name: "Crumb & Co", business_type: "home bakery", store_platform: "woocommerce",
    gmv_band: "small", risk_band: "low", failure_history: "high", wave: 1, ray_on: false, connector_on: false,
    whatsapp_on: false, banking_plus: false, udyam: false, approval_limit: 0,
  }),
  merchant({
    id: "m_spice_route", name: "Spice Route Foods", business_type: "packaged food", store_platform: "woocommerce",
    gmv_band: "small", risk_band: "low", failure_history: "high", wave: 2, ray_on: false, connector_on: false,
    whatsapp_on: false, banking_plus: false, udyam: false, approval_limit: 0,
  }),
  merchant({
    id: "m_quizpad", name: "QuizPad", business_type: "saas_b2c", store_platform: "custom",
    gmv_band: "small", risk_band: "low", failure_history: "low", wave: 1, ray_on: false, connector_on: false,
    whatsapp_on: false, banking_plus: false, udyam: false, approval_limit: 0,
  }),
  merchant({
    id: "m_brandsmith", name: "Brandsmith Agency", business_type: "agency_b2b", store_platform: "custom",
    gmv_band: "medium", risk_band: "medium", failure_history: "low", wave: 2, ray_on: false, connector_on: false,
    whatsapp_on: false, banking_plus: false, udyam: false, approval_limit: 0,
  }),
  merchant({
    id: "m_yoganest", name: "YogaNest", business_type: "fitness app", store_platform: "app",
    gmv_band: "small", risk_band: "low", failure_history: "medium", wave: 1, ray_on: false, connector_on: false,
    whatsapp_on: false, banking_plus: false, udyam: false, approval_limit: 0,
  }),
  merchant({
    id: "m_ludhiana_corrugators", name: "Ludhiana Corrugators", business_type: "packaging manufacturer",
    store_platform: "none", gmv_band: "medium", risk_band: "low", failure_history: "medium", wave: 1,
    ray_on: false, connector_on: false, whatsapp_on: false, banking_plus: true, udyam: true, approval_limit: 0,
  }),
];

const LEAFY = "m_leafy_bakes";
const PLUGIN = "razorpay-woocommerce";
const PLUGIN_VERSION = "4.8.2";

// Splits a rupee total into n amounts (multiples of ₹100) that add up exactly.
export function split(total: number, n: number, salt: number): number[] {
  const weights = Array.from({ length: n }, (_, i) => 2 + ((i * 7 + salt) % 5));
  const sum = weights.reduce((a, b) => a + b, 0);
  const out = weights.map((w) => Math.round((total * w) / sum / 100) * 100);
  out[n - 1] += total - out.reduce((a, b) => a + b, 0);
  return out;
}

export const PACKRIGHT = {
  openInvoices: 38,
  overdueInvoices: 16,
  openTotal: rupees(14.2 * LAKH),
  overdueTotal: rupees(6.1 * LAKH),
};

export function seed(db: Db, now: number = SEED_NOW) {
  const repo = createRepository(db);
  if (repo.merchants.list().length > 0) {
    throw new Error("Database already seeded. Run npm run db:reset first.");
  }
  const ago = (ms: number) => now - ms;

  db.transaction(() => {
    repo.merchants.insertMany(MERCHANTS);

    // Leafy Bakes: paid but no order, and chargebacks
    repo.customers.insertMany([
      { id: "cus_priya", merchant_id: LEAFY, name: "Priya Sharma", email: "priya.sharma@example.com", phone: "+919800000101" },
      { id: "cus_rahul", merchant_id: LEAFY, name: "Rahul M", email: "rahul.m@example.com", phone: "+919800000102" },
      { id: "cus_ankit", merchant_id: LEAFY, name: "ankit.s", phone: "+919800000103" },
      { id: "cus_meera", merchant_id: LEAFY, name: "Meera Iyer", email: "meera.iyer@example.com", phone: "+919800000104" },
      { id: "cus_sanjay", merchant_id: LEAFY, name: "Sanjay Kulkarni", email: "sanjay.k@example.com", phone: "+919800000105" },
      { id: "cus_deepa", merchant_id: LEAFY, name: "Deepa Nair", email: "deepa.nair@example.com", phone: "+919800000106" },
      // Consent edge cases: Kavya opted out of WhatsApp, Imran never gave consent.
      { id: "cus_kavya", merchant_id: LEAFY, name: "Kavya Rao", email: "kavya.rao@example.com", phone: "+919800000107" },
      { id: "cus_imran", merchant_id: LEAFY, name: "Imran Qureshi", email: "imran.q@example.com", phone: "+919800000108" },
    ]);

    const paidOrder = (id: string, amount: number, receipt: string, at: number) =>
      ({ id, merchant_id: LEAFY, status: "paid", amount, receipt, created_at: at });
    repo.rzpOrders.insertMany([
      paidOrder("order_LB1234", rupees(1_299), "wc_1234", ago(40 * MIN)),
      paidOrder("order_LB1235", rupees(499), "wc_1235", ago(3 * HOUR)),
      paidOrder("order_LB1198", rupees(6_900), "wc_1198", ago(26 * DAY)),
      paidOrder("order_LB1210", rupees(1_299), "wc_1210", ago(21 * DAY)),
      paidOrder("order_LB1221", rupees(1_850), "wc_1221", ago(18 * DAY)),
    ]);

    const upi = (
      id: string, order_id: string, amount: number, contact: string, email: string | null,
      vpa: string, utr: string, at: number,
    ) => ({
      id, merchant_id: LEAFY, order_id, status: "captured", amount, method: "upi", contact, email, vpa, utr,
      receipt: order_id.replace("order_LB", "wc_"), created_at: at, captured_at: at + 5_000,
    });
    const card = (
      id: string, order_id: string, amount: number, contact: string, email: string, last4: string, at: number,
    ) => ({
      id, merchant_id: LEAFY, order_id, status: "captured", amount, method: "card", contact, email,
      card_last4: last4, card_country: "IN", receipt: order_id.replace("order_LB", "wc_"), created_at: at,
      captured_at: at + 5_000,
    });
    repo.rzpPayments.insertMany([
      upi("pay_LB1234PRIYA", "order_LB1234", rupees(1_299), "+919800000101", "priya.sharma@example.com",
        "priya.sharma@okaxis", "628514730021", ago(38 * MIN)),
      upi("pay_LB1235RAHUL1", "order_LB1235", rupees(499), "+919800000102", "rahul.m@example.com",
        "rahulm@okicici", "628514730118", ago(3 * HOUR - 2 * MIN)),
      upi("pay_LB1235RAHUL2", "order_LB1235", rupees(499), "+919800000102", "rahul.m@example.com",
        "rahulm@okicici", "628514730119", ago(3 * HOUR - 4 * MIN)),
      card("pay_LB1198MEERA", "order_LB1198", rupees(6_900), "+919800000104", "meera.iyer@example.com", "4417", ago(26 * DAY)),
      card("pay_LB1210SANJAY", "order_LB1210", rupees(1_299), "+919800000105", "sanjay.k@example.com", "5520", ago(21 * DAY)),
      card("pay_LB1221DEEPA", "order_LB1221", rupees(1_850), "+919800000106", "deepa.nair@example.com", "4093", ago(18 * DAY)),
    ]);

    const item = (name: string, price: number, stock: number, qty = 1) => ({ name, qty, price, stock });
    repo.storeOrders.insertMany([
      {
        id: "so_leafy_1234", number: "#1234", merchant_id: LEAFY, customer_id: "cus_priya", status: "pending",
        status_history: [{ status: "pending", at: ago(40 * MIN) }], razorpay_order_id: "order_LB1234",
        receipt: "wc_1234", payment_id: null, total: rupees(1_299),
        items: [item("Chocolate box", rupees(1_299), 12)], stock: 12, created_at: ago(40 * MIN),
      },
      {
        id: "so_leafy_1235", number: "#1235", merchant_id: LEAFY, customer_id: "cus_rahul", status: "processing",
        status_history: [{ status: "pending", at: ago(3 * HOUR) }, { status: "processing", at: ago(3 * HOUR - 2 * MIN) }],
        razorpay_order_id: "order_LB1235", receipt: "wc_1235", payment_id: "pay_LB1235RAHUL1", total: rupees(499),
        items: [item("Banana bread loaf", rupees(499), 7)], stock: 7, created_at: ago(3 * HOUR),
      },
      ...[
        { n: "1198", cus: "cus_meera", pay: "pay_LB1198MEERA", amt: 6_900, it: "Party cake, 2 kg", stock: 3, d: 26 },
        { n: "1210", cus: "cus_sanjay", pay: "pay_LB1210SANJAY", amt: 1_299, it: "Chocolate box", stock: 12, d: 21 },
        { n: "1221", cus: "cus_deepa", pay: "pay_LB1221DEEPA", amt: 1_850, it: "Cookie hamper", stock: 5, d: 18 },
      ].map((o) => ({
        id: `so_leafy_${o.n}`, number: `#${o.n}`, merchant_id: LEAFY, customer_id: o.cus, status: "completed" as const,
        status_history: [
          { status: "processing", at: ago(o.d * DAY) },
          { status: "completed", at: ago((o.d - 2) * DAY), note: "Shipped by courier" },
        ],
        razorpay_order_id: `order_LB${o.n}`, receipt: `wc_${o.n}`, payment_id: o.pay, total: rupees(o.amt),
        items: [item(o.it, rupees(o.amt), o.stock)], stock: o.stock, created_at: ago(o.d * DAY),
      })),
    ]);

    const delivery = (event_id: string, event: string, payment_id: string, at: number, processed: boolean, cron_note: string | null) => ({
      event_id, merchant_id: LEAFY, event, url: "https://leafybakes.example.com/?wc-api=razorpay_webhook",
      http_status: 200, response_body: "OK", delivered_at: at, plugin: PLUGIN, plugin_version: PLUGIN_VERSION,
      processed, cron_note, payment_id,
    });
    repo.webhookDeliveries.insertMany([
      delivery("evt_LB_priya_captured", "payment.captured", "pay_LB1234PRIYA", ago(38 * MIN), false,
        "Queued for cron. Cron marked the job done; order not updated."),
      delivery("evt_LB_priya_order_paid", "order.paid", "pay_LB1234PRIYA", ago(38 * MIN), false,
        "Queued for cron. Cron marked the job done; order not updated."),
      delivery("evt_LB_rahul_captured_1", "payment.captured", "pay_LB1235RAHUL1", ago(3 * HOUR - 2 * MIN), true, null),
      delivery("evt_LB_rahul_captured_2", "payment.captured", "pay_LB1235RAHUL2", ago(3 * HOUR - 4 * MIN), true,
        "Order already processing; second payment ignored."),
    ]);
    // Simulated store state: Leafy Bakes runs plugin 4.8.2 with the
    // 200-but-dropped bug, matching the deliveries above.
    repo.storeSettings.insertMany([
      { merchant_id: LEAFY, webhook_enabled: true, site_status: "up", plugin: PLUGIN, plugin_version: PLUGIN_VERSION, failure_mode: "dropped_200" },
      ...["m_crumb_co", "m_spice_route"].map((merchant_id) => ({
        merchant_id, webhook_enabled: true, site_status: "up" as const, plugin: PLUGIN, plugin_version: "4.9.1",
        failure_mode: "none" as const,
      })),
    ]);
    repo.products.insertMany([
      { id: "prd_LB_chocbox", merchant_id: LEAFY, sku: "LB-CHOCBOX", name: "Chocolate box", price: rupees(1_299), stock: 12 },
      { id: "prd_LB_banana", merchant_id: LEAFY, sku: "LB-BANANA", name: "Banana bread loaf", price: rupees(499), stock: 7 },
      { id: "prd_LB_partycake", merchant_id: LEAFY, sku: "LB-PARTYCAKE-2KG", name: "Party cake, 2 kg", price: rupees(6_900), stock: 3 },
      { id: "prd_LB_hamper", merchant_id: LEAFY, sku: "LB-HAMPER", name: "Cookie hamper", price: rupees(1_850), stock: 5 },
    ]);

    repo.pluginReports.insert({
      id: "pr_woo_482_1", merchant_id: "m_crumb_co", plugin: PLUGIN, plugin_version: PLUGIN_VERSION,
      failure: "Webhook answered 200 but order stayed Pending", reported_at: ago(5 * DAY),
    });

    const dispute = (id: string, payment_id: string, amount: number, reason_code: string, reason: string, network: string, respondDays: number, openedDaysAgo: number) => ({
      id, merchant_id: LEAFY, payment_id, amount, reason_code, reason, network, phase: "chargeback" as const,
      deducted: true, respond_by: now + respondDays * DAY, status: "open", lane: null, created_at: ago(openedDaysAgo * DAY),
    });
    repo.disputes.insertMany([
      dispute("disp_LB_meera", "pay_LB1198MEERA", rupees(6_900), "13.1", "Product not received", "Visa", 6, 1),
      dispute("disp_LB_sanjay", "pay_LB1210SANJAY", rupees(1_299), "4834", "Duplicate charge", "Mastercard", 4, 3),
      dispute("disp_LB_deepa", "pay_LB1221DEEPA", rupees(1_850), "13.1", "Product not received", "Visa", 9, 0),
    ]);

    // International card declined
    repo.customers.insertMany([
      { id: "cus_emma", merchant_id: "m_notenest", name: "Emma Clarke", email: "emma.clarke@example.com", country: "US" },
      { id: "cus_oliver", merchant_id: "m_pixelforge", name: "Oliver Bennett", email: "oliver@example.co.uk", country: "GB" },
    ]);
    repo.rzpOrders.insertMany([
      { id: "order_NN_emma", merchant_id: "m_notenest", status: "attempted", amount: 4_900, currency: "USD", receipt: "nn_pro_annual_881", created_at: ago(25 * MIN) },
      { id: "order_PF_oliver", merchant_id: "m_pixelforge", status: "attempted", amount: 280_000, currency: "GBP", receipt: "pf_inv_2041", created_at: ago(2 * HOUR) },
    ]);
    repo.rzpPayments.insertMany([
      {
        id: "pay_NN_emma_failed", merchant_id: "m_notenest", order_id: "order_NN_emma", status: "failed",
        amount: 4_900, currency: "USD", base_amount: rupees(4_100), method: "card", email: "emma.clarke@example.com",
        card_last4: "4242", card_country: "US", error_code: "BAD_REQUEST_ERROR", error_source: "business",
        error_reason: "international_transaction_not_allowed", receipt: "nn_pro_annual_881", created_at: ago(24 * MIN),
      },
      {
        id: "pay_PF_oliver_failed", merchant_id: "m_pixelforge", order_id: "order_PF_oliver", status: "failed",
        amount: 280_000, currency: "GBP", base_amount: rupees(3.1 * LAKH), method: "card", email: "oliver@example.co.uk",
        card_last4: "8810", card_country: "GB", error_code: "BAD_REQUEST_ERROR", error_source: "business",
        error_reason: "amount_exceeds_maximum_amount_allowed", receipt: "pf_inv_2041", created_at: ago(2 * HOUR - 3 * MIN),
      },
    ]);

    // Subscriptions
    repo.customers.insertMany([
      { id: "cus_karan", merchant_id: "m_fitloop", name: "Karan Mehta", email: "karan.mehta@example.com", phone: "+919800000201" },
      { id: "cus_acme", merchant_id: "m_stackly", name: "Acme Logistics", email: "accounts@acmelogistics.example.com", phone: "+919800000202" },
      { id: "cus_neha", merchant_id: "m_sharma_tutorials", name: "Neha Gupta", email: "neha.gupta@example.com", phone: "+919800000203" },
    ]);
    const month = 30 * DAY;
    repo.subscriptions.insertMany([
      {
        id: "sub_FL_karan", merchant_id: "m_fitloop", customer_id: "cus_karan", status: "pending", plan: "FitLoop Monthly",
        amount: rupees(499), retries_left: 2, pending_invoice_id: "inv_FL_karan_3", b2b: false,
        lifetime_value: rupees(499) * 2, started_at: ago(2 * month + 2 * DAY),
      },
      {
        id: "sub_ST_acme", merchant_id: "m_stackly", customer_id: "cus_acme", status: "halted", plan: "Stackly Team",
        amount: rupees(24_000), retries_left: 0, pending_invoice_id: "inv_ST_acme_3", b2b: true,
        lifetime_value: rupees(24_000) * 2, started_at: ago(2 * month + 5 * DAY),
      },
      {
        id: "sub_STU_neha", merchant_id: "m_sharma_tutorials", customer_id: "cus_neha", status: "active",
        plan: "Monthly tuition", amount: rupees(3_000), retries_left: 3, pending_invoice_id: null, b2b: false,
        lifetime_value: rupees(3_000) * 2, started_at: ago(2 * month - 3 * DAY),
      },
    ]);
    repo.mandates.insertMany([
      { id: "mdt_FL_karan", subscription_id: "sub_FL_karan", method: "upi_autopay", token_id: "token_FL_karan", status: "active", max_amount: rupees(2_000) },
      { id: "mdt_ST_acme", subscription_id: "sub_ST_acme", method: "card", token_id: "token_ST_acme", status: "expired", max_amount: rupees(50_000), expires_at: ago(8 * DAY) },
      { id: "mdt_STU_neha", subscription_id: "sub_STU_neha", method: "upi_autopay", token_id: "token_STU_neha", status: "cancelled", max_amount: rupees(5_000) },
    ]);
    const cycle = (subId: string, n: number, amount: number, start: number, status: string, attempts: number, error_reason: string | null = null) => ({
      id: `${subId.replace("sub_", "inv_")}_${n}`, subscription_id: subId, amount, status, attempts, error_reason,
      billing_start: start, billing_end: start + month,
    });
    const fl = ago(2 * month + 2 * DAY);
    const st = ago(2 * month + 5 * DAY);
    const stu = ago(2 * month - 3 * DAY);
    repo.subInvoices.insertMany([
      cycle("sub_FL_karan", 1, rupees(499), fl, "paid", 1),
      cycle("sub_FL_karan", 2, rupees(499), fl + month, "paid", 1),
      cycle("sub_FL_karan", 3, rupees(499), fl + 2 * month, "issued", 1, "Insufficient balance in bank account"),
      cycle("sub_ST_acme", 1, rupees(24_000), st, "paid", 1),
      cycle("sub_ST_acme", 2, rupees(24_000), st + month, "paid", 1),
      cycle("sub_ST_acme", 3, rupees(24_000), st + 2 * month, "issued", 4, "Card expired"),
      cycle("sub_STU_neha", 1, rupees(3_000), stu, "paid", 1),
      cycle("sub_STU_neha", 2, rupees(3_000), stu + month, "paid", 1),
    ]);

    // PackRight: B2B invoices overdue
    const PR = "m_packright";
    const BUYERS = [
      { id: "buy_gill_agro", name: "Gill Agro Foods", contact_name: "Harpreet Gill", avg_days_late: 3, pay_history: "Pays within a few days of due date. Key account.", usual_tds_rate: 0.1, key_account: true },
      { id: "buy_bansal_traders", name: "Bansal Packaging Traders", contact_name: "Vikas Bansal", avg_days_late: 21, pay_history: "Usually 2 to 4 weeks late, pays in full after one reminder.", usual_tds_rate: 2, key_account: false },
      { id: "buy_sidhu_dairy", name: "Sidhu Dairy Co", contact_name: "Gurleen Sidhu", avg_days_late: 0, pay_history: "Always on time.", usual_tds_rate: 0, key_account: false },
      { id: "buy_mehra_snacks", name: "Mehra Snacks Pvt Ltd", contact_name: "Anil Mehra", avg_days_late: 45, pay_history: "Slow payer. Often promises a date and misses it.", usual_tds_rate: 1, key_account: false },
      { id: "buy_kohli_exports", name: "Kohli Exports", contact_name: "Simran Kohli", avg_days_late: 12, pay_history: "Pays in parts, often clubs several invoices into one transfer.", usual_tds_rate: 2, key_account: false },
    ];
    repo.buyers.insertMany(
      BUYERS.map((b, i) => ({ ...b, merchant_id: PR, email: `accounts@${b.id.slice(4).replace("_", "")}.example.com`, phone: `+91980000030${i + 1}` })),
    );

    const overdueAmounts = split(PACKRIGHT.overdueTotal / 100, PACKRIGHT.overdueInvoices, 1);
    const upcomingAmounts = split((PACKRIGHT.openTotal - PACKRIGHT.overdueTotal) / 100, PACKRIGHT.openInvoices - PACKRIGHT.overdueInvoices, 3);
    const invoiceRows = [...overdueAmounts.map((a) => ({ a, overdue: true })), ...upcomingAmounts.map((a) => ({ a, overdue: false }))].map(
      ({ a, overdue }, i) => {
        const buyer = BUYERS[i % BUYERS.length];
        const dueOffset = overdue ? -(3 + ((i * 11) % 50)) * DAY : (2 + ((i * 5) % 40)) * DAY;
        const due = now + dueOffset;
        return {
          id: `inv_PR_${2401 + i}`, merchant_id: PR, buyer_id: buyer.id, number: `PR/26-27/${2401 + i}`, amount: rupees(a),
          issued_at: due - 30 * DAY, due_date: due, accepted_at: due - 29 * DAY, status: "open", paid_amount: 0,
          key_account: buyer.key_account, disputed_part: null as number | null,
        };
      },
    );
    invoiceRows[3].disputed_part = rupees(8_500); // Mehra Snacks says one pallet arrived damaged
    repo.invoices.insertMany(invoiceRows);

    repo.promises.insertMany([
      { id: "prm_PR_1", invoice_id: invoiceRows[3].id, buyer_id: invoiceRows[3].buyer_id, promised_date: ago(4 * DAY), amount: invoiceRows[3].amount, made_at: ago(12 * DAY), status: "broken" },
      { id: "prm_PR_2", invoice_id: invoiceRows[1].id, buyer_id: invoiceRows[1].buyer_id, promised_date: now + 3 * DAY, amount: invoiceRows[1].amount, made_at: ago(2 * DAY), status: "open" },
    ]);

    // Unmatched bank credits for Collect to reconcile later (net of usual TDS).
    const net = (inv: (typeof invoiceRows)[number], tds: number) => Math.round(inv.amount * (1 - tds / 100));
    const kohli = invoiceRows.filter((r) => r.buyer_id === "buy_kohli_exports" && r.due_date < now);
    repo.bankCredits.insertMany([
      { id: "bc_PR_1", merchant_id: PR, amount: net(invoiceRows[1], 2), remark: "NEFT BANSAL PACKAGING TRADERS INV 2402", utr: "SBIN0026101845", date: ago(1 * DAY), matched_invoices: [] },
      { id: "bc_PR_2", merchant_id: PR, amount: net(kohli[0], 2) + net(kohli[1], 2), remark: "RTGS KOHLI EXPORTS PAYMENT", utr: "HDFCR52026101211", date: ago(2 * DAY), matched_invoices: [] },
      { id: "bc_PR_3", merchant_id: PR, amount: rupees(18_000), remark: "IMPS 6281 SUPPLIER PMT", utr: "628510004417", date: ago(3 * HOUR), matched_invoices: [] },
    ]);

    // Rules RAY proposes at setup for every merchant with RAY on, all off
    // (proposed) until the merchant approves them.
    for (const m of MERCHANTS.filter((m) => m.ray_on)) proposeSetupRules(db, m.id);

    // Leafy Bakes sends paid-no-order replies from its verified domain
    // (support@leafybakes.in). A playbook setting, so it can never approve
    // an action.
    repo.playbookRules.insert({
      id: "rule_setting_send_from_leafy_pno", merchant_id: LEAFY, moment: "paid_no_order",
      rule_json: { setting: "send_from", value: "verified_domain", tool: "none" }, text: "Send customer messages from",
      source: "merchant", status: "approved", approved_at: ago(30 * DAY),
    });

    // WhatsApp opt-ins collected at checkout, for customers of merchants with
    // WhatsApp on. Kavya later opted out; Imran has no consent row at all.
    const whatsappMerchants = new Set(MERCHANTS.filter((m) => m.whatsapp_on).map((m) => m.id));
    const NO_CONSENT = new Set(["cus_imran"]);
    repo.messagingConsents.insertMany(
      repo.customers
        .list()
        .filter((c) => c.phone && whatsappMerchants.has(c.merchant_id) && !NO_CONSENT.has(c.id))
        .map((c) =>
          c.id === "cus_kavya"
            ? { id: `cons_${c.id}_wa`, customer_id: c.id, channel: "whatsapp" as const, status: "opted_out" as const, source: "customer replied STOP", updated_at: ago(5 * DAY) }
            : { id: `cons_${c.id}_wa`, customer_id: c.id, channel: "whatsapp" as const, status: "opted_in" as const, source: "checkout", updated_at: ago(30 * DAY) },
        ),
    );

    // Call opt-ins (Step 5b): calls only go to customers who said yes.
    // Deepa asked not to be called; everyone else has no call consent.
    const call = (customer_id: string, status: "opted_in" | "opted_out", source: string) =>
      ({ id: `cons_${customer_id}_call`, customer_id, channel: "call" as const, status, source, updated_at: ago(30 * DAY) });
    repo.messagingConsents.insertMany([
      call("cus_priya", "opted_in", "checkout"),
      call("cus_rahul", "opted_in", "checkout"),
      call("cus_karan", "opted_in", "checkout"),
      call("cus_deepa", "opted_out", "asked not to be called"),
    ]);

    seedInternational(db, now);
    seedSubscriptions(db); // Step 9: mandate approvals, pre-debit notices, subscription playbook values
    seedChargebacks(db, now);
    seedCollect(db, now);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const db = openMigratedDb();
  seed(db);
  db.$client.close();
  console.log("Seeded fictional merchants for all five moments.");
}
