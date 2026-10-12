// Typed repository over every table. Ordinary tables get insert, get, list
// and update. case_events is append only: insert and read, nothing else.
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Db } from "./client";
import * as s from "./schema";

function crud<T extends SQLiteTable>(db: Db, table: T, key: SQLiteColumn) {
  type Row = T["$inferSelect"];
  type New = T["$inferInsert"];
  return {
    insert(row: New): Row {
      return db.insert(table).values(row).returning().get() as Row;
    },
    insertMany(rows: New[]): void {
      if (rows.length > 0) db.insert(table).values(rows).run();
    },
    get(id: string): Row | undefined {
      return db.select().from(table).where(eq(key, id)).get() as Row | undefined;
    },
    list(where?: SQL): Row[] {
      return db.select().from(table).where(where).all() as Row[];
    },
    update(id: string, patch: Partial<New>): Row | undefined {
      return db.update(table).set(patch).where(eq(key, id)).returning().get() as Row | undefined;
    },
  };
}

type CaseEvent = typeof s.caseEvents.$inferSelect;
type NewCaseEvent = Omit<typeof s.caseEvents.$inferInsert, "seq">;

function caseEventsRepo(db: Db) {
  return Object.freeze({
    insert(row: NewCaseEvent): CaseEvent {
      // seq is computed in the same statement, so it can't race another insert.
      const seq = sql`(select coalesce(max(seq), 0) + 1 from case_events)`;
      return db.insert(s.caseEvents).values({ ...row, seq }).returning().get();
    },
    get(id: string): CaseEvent | undefined {
      return db.select().from(s.caseEvents).where(eq(s.caseEvents.id, id)).get();
    },
    listByCase(caseId: string): CaseEvent[] {
      return db
        .select()
        .from(s.caseEvents)
        .where(eq(s.caseEvents.case_id, caseId))
        // Time order, with seq breaking ties so same-timestamp events keep insert order.
        .orderBy(asc(s.caseEvents.at), asc(s.caseEvents.seq))
        .all();
    },
  });
}

export function createRepository(db: Db) {
  const byId = <T extends SQLiteTable & { id: SQLiteColumn }>(table: T) => crud(db, table, table.id);
  return {
    merchants: byId(s.merchants),
    customers: byId(s.customers),
    cases: byId(s.cases),
    caseEvents: caseEventsRepo(db),
    actions: byId(s.actions),
    timers: byId(s.timers),
    messages: byId(s.messages),
    messagingConsents: byId(s.messagingConsents),
    playbookRules: byId(s.playbookRules),
    memory: byId(s.memory),
    aiCalls: byId(s.aiCalls),
    alerts: byId(s.alerts),
    rzpPayments: byId(s.rzpPayments),
    rzpOrders: byId(s.rzpOrders),
    rzpRefunds: byId(s.rzpRefunds),
    rzpLinks: byId(s.rzpLinks),
    storeOrders: byId(s.storeOrders),
    webhookDeliveries: crud(db, s.webhookDeliveries, s.webhookDeliveries.event_id),
    storeSettings: crud(db, s.storeSettings, s.storeSettings.merchant_id),
    products: byId(s.products),
    pluginReports: byId(s.pluginReports),
    downtimes: byId(s.downtimes),
    subscriptions: byId(s.subscriptions),
    mandates: byId(s.mandates),
    subInvoices: byId(s.subInvoices),
    disputes: byId(s.disputes),
    buyers: byId(s.buyers),
    invoices: byId(s.invoices),
    promises: byId(s.promises),
    bankCredits: byId(s.bankCredits),
  };
}

export type Repository = ReturnType<typeof createRepository>;

export { and, eq };
