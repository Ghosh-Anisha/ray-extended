// Schemas, code guards, the investigate loop, live and record modes.
import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { aiModeFrom } from ".";
import { readFixture } from "./fixtures";
import { converseOutput } from "./jobs/converse";
import { decideOutput } from "./jobs/decide";
import { INVESTIGATE_STEP_CAP, investigateStepOutput, type InvestigateRequest } from "./jobs/investigate";
import { learnOutput } from "./jobs/learn";
import { understandOutput } from "./jobs/understand";
import { verifyOutput } from "./jobs/verify";
import { writeOutput } from "./jobs/write";
import { SMALL_MODEL, STRONG_MODEL } from "./models";
import { READ_TOOLS, type ReadToolRunner } from "@/tools";
import { canAct } from "./runner";
import { aiWorld, scriptedClient, tmpDir } from "./test-helpers";

const live = (answer: Parameters<typeof scriptedClient>[0]) => {
  const s = scriptedClient(answer);
  return { ...aiWorld({ mode: "live", client: s.client, fixturesDir: tmpDir() }), seen: s.seen };
};

describe("output schemas", () => {
  const cases = [
    {
      job: "understand",
      schema: understandOutput,
      good: { amount: 1299, rough_time: null, utr: null, payment_id: null, intent: "paid_no_order", language: "en", mood: "calm", legal_or_chargeback_words: [], confidence: "sure" },
      bad: { amount: "1299", intent: "paid_no_order", confidence: "certain" },
    },
    {
      job: "investigate",
      schema: investigateStepOutput,
      good: { findings: [{ text: "t", evidence_id: "e", supports: "x" }], next: null, cause: null, side: "merchant", situation: "A", confidence: "likely" },
      bad: { findings: [{ text: "no evidence" }], next: null, cause: null, side: "nobody", situation: null, confidence: "sure" },
    },
    {
      job: "decide",
      schema: decideOutput,
      good: { proposal: "fulfil", reason: "r", rule_id: null, confidence: "sure" },
      bad: { proposal: "wire_money_abroad", reason: "r", rule_id: null, confidence: "sure" },
    },
    {
      job: "converse",
      schema: converseOutput,
      good: { kind: "question", question: "q", read: null, points_to: null, confidence: "sure" },
      bad: { kind: "decide", question: null, read: null, points_to: null, confidence: "sure" },
    },
    { job: "write", schema: writeOutput, good: { draft: "Hi", confidence: "sure" }, bad: { text: "Hi", confidence: "sure" } },
    { job: "verify", schema: verifyOutput, good: { status: "arrived", confidence: "sure" }, bad: { status: "probably", confidence: "sure" } },
    {
      job: "learn",
      schema: learnOutput,
      good: { rule: null, evidence: [], confidence: "unsure" },
      bad: { rule: { text: "t", status: "approved" }, evidence: [], confidence: "sure" },
    },
  ] as const;
  for (const c of cases) {
    it(`${c.job} accepts a good output and rejects a bad one`, () => {
      expect(c.schema.safeParse(c.good).success).toBe(true);
      expect(c.schema.safeParse(c.bad).success).toBe(false);
    });
  }
});

describe("investigate", () => {
  const request: InvestigateRequest = {
    case: { id: "case_T1", moment: "paid_no_order", payment_id: "pay_T1" },
    evidence: [{ id: "ce_T1", type: "webhook", summary: "payment.captured" }],
  };
  const step = (over: object) => ({ findings: [], next: null, cause: null, side: null, situation: null, confidence: "likely", ...over });

  it("stops at the step cap of 6", async () => {
    const { ai, seen, calls } = live(() => step({ next: { tool: "get_payment", id: "pay_T1" }, confidence: "sure" }));
    const tools = vi.fn<ReadToolRunner>(async () => ({ evidence_ids: ["pay_T1"], data: {} }));
    const r = await ai.investigate(request, tools);
    expect(INVESTIGATE_STEP_CAP).toBe(6);
    expect(r.stoppedBy).toBe("step_cap");
    expect(seen).toHaveLength(6);
    expect(r.steps).toBe(6);
    expect(tools).toHaveBeenCalledTimes(5);
    expect(calls()).toHaveLength(6);
    expect(r.confidence).toBe("unsure"); // no findings
  });

  it("refuses a write tool and never runs it", async () => {
    const { ai } = live(() =>
      step({ findings: [{ text: "Captured", evidence_id: "ce_T1", supports: "x" }], next: { tool: "refund", id: "pay_T1" }, confidence: "sure" }),
    );
    const tools = vi.fn<ReadToolRunner>();
    const r = await ai.investigate(request, tools);
    expect(r.stoppedBy).toBe("refused_tool");
    expect(r.refusedTool).toBe("refund");
    expect(tools).not.toHaveBeenCalled();
    expect(r.confidence).toBe("unsure");
  });

  it("has no act tool on its read list", () => {
    for (const t of ["refund", "mark_paid", "send_message", "capture", "cancel_order", "contest_dispute", "post_match"]) {
      expect(READ_TOOLS as readonly string[]).not.toContain(t);
    }
  });

  it("rejects a finding that cites evidence it was never given", async () => {
    const { ai } = live(() => step({ findings: [{ text: "Made up", evidence_id: "pay_INVENTED", supports: "x" }], confidence: "sure" }));
    const r = await ai.investigate(request, vi.fn());
    expect(r.stoppedBy).toBe("fallback");
    expect(r.findings).toEqual([]);
    expect(r.confidence).toBe("unsure");
  });

  it("puts tool results in the next step's history so their ids can be cited", async () => {
    const { ai, seen } = live((_req, n) =>
      n === 1
        ? step({ next: { tool: "get_payment", id: "pay_T1" } })
        : step({ findings: [{ text: "Captured", evidence_id: "pay_T1", supports: "x" }], cause: "c", side: "merchant", confidence: "sure" }),
    );
    const r = await ai.investigate(request, async () => ({ evidence_ids: ["pay_T1"], data: { status: "captured" } }));
    expect(r.stoppedBy).toBe("done");
    expect(r.findings).toEqual([{ text: "Captured", evidenceRef: "pay_T1" }]);
    expect((seen[1].input as { history: unknown[] }).history).toHaveLength(1);
  });
});

describe("code guards", () => {
  it("understand rejects an amount that isn't in the message", async () => {
    const { ai } = live(() => ({
      amount: 1999, rough_time: null, utr: null, payment_id: null, intent: "paid_no_order", language: "en", mood: "calm", legal_or_chargeback_words: [], confidence: "sure",
    }));
    const r = await ai.understand({ text: "I paid 1299 and got nothing" });
    expect(r.fallbackReason).toBe("guard_failed");
    expect(r.output.amount).toBeNull();
  });

  it("decide on an Unsure case can only ask or escalate", async () => {
    const { ai } = live(() => ({ proposal: "refund", reason: "r", rule_id: null, confidence: "sure" }));
    const r = await ai.decide({ moment: "paid_no_order", case: { confidence: "unsure" }, findings: [], playbook: [], memory: [] });
    expect(r.fallbackReason).toBe("guard_failed");
    expect(canAct(r)).toBe(false);
  });

  it("decide rejects a rule that isn't approved, and an option from another moment", async () => {
    const { ai } = live((_q, n) =>
      n === 1 ? { proposal: "fulfil", reason: "r", rule_id: "rule_P", confidence: "sure" } : { proposal: "contest_dispute", reason: "r", rule_id: null, confidence: "sure" },
    );
    const base = { moment: "paid_no_order" as const, case: { confidence: "sure" as const }, findings: [], memory: [] };
    const playbook = [{ id: "rule_P", moment: "paid_no_order" as const, text: "t", status: "proposed" as const }];
    expect((await ai.decide({ ...base, playbook })).problems?.join()).toMatch(/not an approved rule/);
    expect((await ai.decide({ ...base, playbook: [] })).problems?.join()).toMatch(/not an option/);
  });

  it("converse takes the match from code on every turn, not from the model", async () => {
    const { ai } = live(() => ({ kind: "read", question: null, read: { amount: null, utr_last4: "4821", rough_time: null }, points_to: "pay_A", confidence: "sure" }));
    const rematch = vi.fn(() => ({ status: "ambiguous" as const, candidateIds: ["pay_A", "pay_B"] }));
    const r = await ai.converse(
      {
        thread: [{ from: "customer", text: "ends 4821" }],
        candidates: [
          { id: "pay_A", amount: 1299, time: "6:10 PM", utr_last4: "4821" },
          { id: "pay_B", amount: 1299, time: "7:52 PM", utr_last4: "3307" },
        ],
      },
      rematch,
    );
    expect(rematch).toHaveBeenCalledWith({ amount: null, utr_last4: "4821", rough_time: null });
    expect(r.match.status).toBe("ambiguous");
    expect(r.agrees).toBe(false);
  });

  it("verify: silence stays unconfirmed and never calls the model", async () => {
    const { ai, seen, calls } = live(() => ({ status: "arrived", confidence: "sure" }));
    const r = await ai.verify(null);
    expect(r.confirmed).toBe(false);
    expect(r.output.status).toBe("unclear");
    expect(seen).toHaveLength(0);
    expect(calls()).toHaveLength(0);
  });

  it("verify: only a sure arrival is confirmed", async () => {
    const { ai } = live((_q, n) => (n === 1 ? { status: "arrived", confidence: "sure" } : { status: "arrived", confidence: "unsure" }));
    expect((await ai.verify("Got it, thanks")).confirmed).toBe(true);
    expect((await ai.verify("I think so?")).confirmed).toBe(false);
  });

  it("learn only proposes, and never above the approval limit", async () => {
    const rule = (max: number) => ({
      rule: { text: "When ...", when: { max_amount: max, in_stock: true, customer_confirmed: true }, then: "mark_paid_and_ship" },
      evidence: ["ch1"],
      confidence: "likely",
    });
    const { ai } = live((_q, n) => (n === 1 ? rule(1500) : rule(5000)));
    const input = { moment: "paid_no_order" as const, approval_limit_rupees: 2000, choices: [{ id: "ch1", text: "t" }] };
    expect((await ai.learn(input)).proposal?.status).toBe("proposed");
    const over = await ai.learn(input);
    expect(over.problems?.join()).toMatch(/approval limit/);
    expect(over.proposal).toBeNull();
  });
});

describe("live and record", () => {
  it("masks names, phones, emails and cards before the call and unmasks after", async () => {
    const { ai, seen } = live((req) => {
      const text = (req.input as { text: string }).text;
      return { amount: 1299, rough_time: null, utr: null, payment_id: null, intent: "paid_no_order", language: "en", mood: "calm", legal_or_chargeback_words: [], confidence: text.includes("[NAME_1]") ? "sure" : "unsure" };
    });
    const text = "This is Asha Verma, +919800000123, asha.v@example.com, card 4111 1111 1111 1111. Paid 1299, UTR 452606882553.";
    const r = await ai.understand({ text }, { names: ["Asha Verma"] });
    const sent = JSON.stringify(seen[0].input);
    for (const pii of ["Asha Verma", "9800000123", "asha.v@example.com", "4111 1111"]) expect(sent).not.toContain(pii);
    expect(sent).toContain("452606882553"); // a UTR is not personal data
    expect(r.output.confidence).toBe("sure");
  });

  it("uses the small model for understand and verify, the stronger one for investigate and decide", async () => {
    const { ai, seen, calls } = live((req) =>
      req.model === SMALL_MODEL ? { status: "unclear", confidence: "unsure" } : { proposal: "ask", reason: "r", rule_id: null, confidence: "likely" },
    );
    await ai.verify("hmm");
    await ai.decide({ moment: "paid_no_order", case: { confidence: "likely" }, findings: [], playbook: [], memory: [] });
    expect(seen.map((s) => s.model)).toEqual([SMALL_MODEL, STRONG_MODEL]);
    expect(calls().map((c) => c.mode)).toEqual(["live", "live"]);
  });

  it("a live error falls back to Unsure", async () => {
    const { ai } = live(() => {
      throw new Error("overloaded");
    });
    const r = await ai.verify("got it");
    expect(r.fallbackReason).toBe("live_error");
    expect(r.confirmed).toBe(false);
  });

  it("record saves a fixture that replay then serves", async () => {
    const dir = tmpDir();
    const s = scriptedClient(() => ({ status: "arrived", confidence: "sure" }));
    const rec = aiWorld({ mode: "record", client: s.client, fixturesDir: dir });
    const first = await rec.ai.verify("Reached today, thank you");
    const { fixture } = readFixture(dir, "verify", first.key);
    expect(fixture).toMatchObject({ label: "recorded live", model: SMALL_MODEL, output: { status: "arrived" } });
    expect(fs.readdirSync(`${dir}/verify`)).toHaveLength(1);

    const replay = aiWorld({ fixturesDir: dir });
    const again = await replay.ai.verify("Reached today, thank you");
    expect(again.source).toBe("replay");
    expect(again.label).toBe("recorded live");
    expect(again.confirmed).toBe(true);
  });

  it("AI_MODE defaults to replay and rejects anything else", () => {
    expect(aiModeFrom({})).toBe("replay");
    expect(aiModeFrom({ AI_MODE: "" })).toBe("replay");
    expect(aiModeFrom({ AI_MODE: "  " })).toBe("replay");
    expect(aiModeFrom({ AI_MODE: "record" })).toBe("record");
    expect(() => aiModeFrom({ AI_MODE: "yolo" })).toThrow();
  });
});
