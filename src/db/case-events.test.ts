import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMigratedDb, type Db } from "./client";
import { createRepository, type Repository } from "./repository";

describe("case_events is append only", () => {
  let db: Db;
  let repo: Repository;

  beforeEach(() => {
    db = openMigratedDb(":memory:");
    repo = createRepository(db);
    repo.merchants.insert({
      id: "m_test", name: "Test Shop", business_type: "test", store_platform: "none", gmv_band: "small",
      risk_band: "low", failure_history: "low", cluster: "none|small|low|low", wave: 1, ray_on: true,
      connector_on: false, whatsapp_on: false, banking_plus: false, udyam: false, approval_limit: 0,
    });
    repo.cases.insert({
      id: "case_1", merchant_id: "m_test", moment: "paid_no_order", state: "likely", confidence: "likely", opened_at: 1,
    });
  });
  afterEach(() => db.$client.close());

  it("exposes only insert and read in the repository layer", () => {
    expect(Object.keys(repo.caseEvents).sort()).toEqual(["get", "insert", "listByCase"]);
    expect(Object.isFrozen(repo.caseEvents)).toBe(true);
  });

  it("inserts and reads back events in time order", () => {
    repo.caseEvents.insert({ id: "ev_2", case_id: "case_1", at: 20, type: "finding", payload: { cause: "x" } });
    repo.caseEvents.insert({ id: "ev_1", case_id: "case_1", at: 10, type: "webhook", payload: { event: "order.paid" } });
    expect(repo.caseEvents.listByCase("case_1").map((e) => e.id)).toEqual(["ev_1", "ev_2"]);
    expect(repo.caseEvents.get("ev_2")?.payload).toEqual({ cause: "x" });
  });

  it("reads events at the same timestamp back in insert order", () => {
    const ids = ["ev_e", "ev_a", "ev_d", "ev_b", "ev_c"];
    for (const id of ids) repo.caseEvents.insert({ id, case_id: "case_1", at: 1_000, type: "note", payload: {} });
    const events = repo.caseEvents.listByCase("case_1");
    expect(events.map((e) => e.id)).toEqual(ids);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(events.every((e) => e.at === 1_000)).toBe(true);
  });

  it("rejects a missing or non-increasing seq at the database level", () => {
    repo.caseEvents.insert({ id: "ev_1", case_id: "case_1", at: 10, type: "note", payload: {} });
    const raw = (q: string) => db.$client.prepare(q).run();
    const insert = (id: string, seq: string) =>
      `insert into case_events (id, case_id, at, type, payload, seq) values ('${id}', 'case_1', 10, 'note', '{}', ${seq})`;
    expect(() => raw(insert("ev_2", "null"))).toThrow(/seq must increase/);
    expect(() => raw(insert("ev_3", "1"))).toThrow(/seq must increase/);
    expect(() => raw(insert("ev_4", "2"))).not.toThrow();
  });

  it("rejects UPDATE and DELETE at the database level", () => {
    repo.caseEvents.insert({ id: "ev_1", case_id: "case_1", at: 10, type: "note", payload: {} });
    const raw = (q: string) => db.$client.prepare(q).run();
    expect(() => raw("update case_events set type = 'finding' where id = 'ev_1'")).toThrow(/append only/);
    expect(() => raw("delete from case_events where id = 'ev_1'")).toThrow(/append only/);
    expect(repo.caseEvents.get("ev_1")?.type).toBe("note");
  });
});
