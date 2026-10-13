import { getTableName, is, sql } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMigratedDb, type Db } from "./client";
import { createRepository, eq, type Repository } from "./repository";
import * as schema from "./schema";
import { PACKRIGHT, SEED_NOW, seed } from "./seed";

const EXPECTED_ROWS: Record<string, number> = {
  merchants: 13,
  customers: 13,
  cases: 0,
  case_events: 0,
  actions: 0,
  timers: 0,
  messages: 0,
  // WhatsApp opt-ins, plus call consents (Step 5b), plus 10 PackRight buyer consents (Step 11).
  messaging_consents: 23,
  playbook_rules: 9, // 7 setup rules + Leafy's send-from setting (Step 7) + PackRight's proposed call threshold (Step 11)
  memory: 0,
  ai_calls: 0,
  alerts: 0,
  rzp_payments: 8,
  rzp_orders: 7,
  rzp_refunds: 0,
  rzp_links: 0,
  store_orders: 5,
  webhook_deliveries: 4,
  store_settings: 3,
  products: 4,
  plugin_reports: 1,
  downtimes: 0,
  subscriptions: 3,
  mandates: 3,
  sub_invoices: 8,
  disputes: 3,
  buyers: 5,
  invoices: 38,
  promises: 2,
  bank_credits: 3,
  global_settings: 0,
  call_sims: 0,
};

const tables = (Object.values(schema) as unknown[]).filter((v): v is SQLiteTable => is(v, SQLiteTable));

describe("seed", () => {
  let db: Db;
  let repo: Repository;

  beforeEach(() => {
    db = openMigratedDb(":memory:");
    seed(db);
    repo = createRepository(db);
  });
  afterEach(() => db.$client.close());

  it("covers every table in the schema", () => {
    expect(tables.map(getTableName).sort()).toEqual(Object.keys(EXPECTED_ROWS).sort());
  });

  it("seeds the expected row count per table", () => {
    const counts = Object.fromEntries(
      tables.map((t) => [getTableName(t), db.get<{ n: number }>(sql`select count(*) as n from ${t}`).n]),
    );
    expect(counts).toEqual(EXPECTED_ROWS);
  });

  it("has seven RAY merchants and six alert-only merchants in the same clusters", () => {
    const all = repo.merchants.list();
    const on = all.filter((m) => m.ray_on);
    const off = all.filter((m) => !m.ray_on);
    expect(on).toHaveLength(7);
    expect(off).toHaveLength(6);
    const onClusters = new Set(on.map((m) => m.cluster));
    for (const m of off) expect(onClusters).toContain(m.cluster);
  });

  it("matches the Step 1 numbers for Leafy Bakes", () => {
    const order = repo.storeOrders.get("so_leafy_1234")!;
    expect(order).toMatchObject({ number: "#1234", status: "pending", total: 129_900, stock: 12 });
    expect(order.items[0]).toMatchObject({ name: "Chocolate box", stock: 12 });
    expect(repo.storeSettings.get("m_leafy_bakes")).toMatchObject({ failure_mode: "dropped_200", plugin_version: "4.8.2", site_status: "up", webhook_enabled: true });
    expect(repo.products.list(eq(schema.products.name, "Chocolate box"))).toMatchObject([{ merchant_id: "m_leafy_bakes", stock: 12 }]);
    const priya = repo.rzpPayments.get("pay_LB1234PRIYA")!;
    expect(priya).toMatchObject({ status: "captured", amount: 129_900, contact: "+919800000101" });

    const rahul = repo.rzpPayments.list(eq(schema.rzpPayments.contact, "+919800000102"));
    expect(rahul.map((p) => p.amount)).toEqual([49_900, 49_900]);

    const ankitClaim = 215_000;
    expect(repo.rzpPayments.list(eq(schema.rzpPayments.amount, ankitClaim))).toHaveLength(0);

    const disputes = repo.disputes.list(eq(schema.disputes.merchant_id, "m_leafy_bakes"));
    expect(disputes.map((d) => [d.amount, d.reason]).sort()).toEqual(
      [
        [129_900, "Duplicate charge"],
        [185_000, "Product not received"],
        [690_000, "Product not received"],
      ].sort(),
    );
    expect(repo.webhookDeliveries.get("evt_LB_priya_order_paid")).toMatchObject({
      http_status: 200,
      processed: false,
      plugin_version: "4.8.2",
    });
  });

  it("matches the Step 1 numbers for international, subscriptions", () => {
    expect(repo.rzpPayments.get("pay_NN_emma_failed")).toMatchObject({ amount: 4_900, currency: "USD", base_amount: 410_000, card_country: "US" });
    expect(repo.rzpPayments.get("pay_PF_oliver_failed")).toMatchObject({ amount: 280_000, currency: "GBP", base_amount: 31_000_000, card_country: "GB" });
    expect(repo.subscriptions.get("sub_FL_karan")).toMatchObject({ amount: 49_900, b2b: false });
    expect(repo.subscriptions.get("sub_ST_acme")).toMatchObject({ amount: 2_400_000, b2b: true });
    expect(repo.subscriptions.get("sub_STU_neha")).toMatchObject({ amount: 300_000 });
  });

  it("gives PackRight 38 open invoices worth ₹14.2 lakh, ₹6.1 lakh overdue, across five buyers", () => {
    const invs = repo.invoices.list(eq(schema.invoices.merchant_id, "m_packright"));
    expect(invs).toHaveLength(PACKRIGHT.openInvoices);
    expect(invs.every((i) => i.status === "open")).toBe(true);
    expect(invs.reduce((a, i) => a + i.amount, 0)).toBe(142_000_000);
    const overdue = invs.filter((i) => i.due_date < SEED_NOW);
    expect(overdue.reduce((a, i) => a + i.amount, 0)).toBe(61_000_000);
    const buyers = repo.buyers.list(eq(schema.buyers.merchant_id, "m_packright"));
    expect(buyers).toHaveLength(5);
    expect(new Set(buyers.map((b) => b.usual_tds_rate)).size).toBeGreaterThan(3);
    expect(new Set(buyers.map((b) => b.avg_days_late)).size).toBe(5);
  });

  it("uses the Step 1 names and merchant facts", () => {
    const customer = (id: string) => repo.customers.get(id)!;
    expect(customer("cus_priya")).toMatchObject({ name: "Priya Sharma", merchant_id: "m_leafy_bakes" });
    expect(customer("cus_rahul")).toMatchObject({ name: "Rahul M", merchant_id: "m_leafy_bakes" });
    expect(customer("cus_ankit")).toMatchObject({ name: "ankit.s", merchant_id: "m_leafy_bakes" });
    expect(customer("cus_emma")).toMatchObject({ name: "Emma Clarke", country: "US", merchant_id: "m_notenest" });
    expect(customer("cus_oliver").name).toMatch(/^Oliver/);
    expect(customer("cus_oliver")).toMatchObject({ country: "GB", merchant_id: "m_pixelforge" });
    expect(customer("cus_karan")).toMatchObject({ name: "Karan Mehta", merchant_id: "m_fitloop" });
    expect(customer("cus_acme")).toMatchObject({ name: "Acme Logistics", merchant_id: "m_stackly" });

    expect(repo.merchants.get("m_leafy_bakes")).toMatchObject({ store_platform: "woocommerce" });
    const leafyDeliveries = repo.webhookDeliveries.list(eq(schema.webhookDeliveries.merchant_id, "m_leafy_bakes"));
    expect(leafyDeliveries.length).toBeGreaterThan(0);
    for (const d of leafyDeliveries) expect(d.plugin_version).toMatch(/^4\.8\./);

    expect(repo.rzpPayments.get("pay_PF_oliver_failed")!.error_reason).toMatch(/exceeds_maximum_amount/);

    const packright = repo.merchants.get("m_packright")!;
    expect(packright).toMatchObject({ udyam: true, banking_plus: true });
    expect(packright.business_type).toMatch(/Ludhiana/);
  });

  it("uses only fictional contact details and no Razorpay keys", () => {
    for (const c of repo.customers.list()) if (c.email) expect(c.email).toMatch(/@([\w-]+\.)*example\.(com|co\.uk)$/);
    for (const b of repo.buyers.list()) if (b.email) expect(b.email).toMatch(/@([\w-]+\.)*example\.com$/);
    const everything = JSON.stringify(tables.map((t) => db.select().from(t).all()));
    expect(everything).not.toMatch(/rzp_(test|live)_/);
  });

  it("refuses to seed twice", () => {
    expect(() => seed(db)).toThrow(/db:reset/);
  });
});
