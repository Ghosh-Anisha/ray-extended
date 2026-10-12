// Every job replays its "recorded in Claude Code" fixtures, a broken
// fixture is rejected, and a miss falls back to Unsure, logged.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { investigateCalls, loadClaudeCodeSources, type ClaudeCodeEntry } from "./claude-code-fixtures";
import { fixturePath } from "./fixtures";
import { fixtureKey } from "./key";
import { canAct } from "./runner";
import { aiWorld, copyFixtures, tmpDir } from "./test-helpers";
import type { ReadToolRunner } from "@/tools";
import { JOBS } from "./types";
import { understandSpec } from "./jobs/understand";
import { investigateStepSpec } from "./jobs/investigate";
import { decideSpec } from "./jobs/decide";
import { converseSpec } from "./jobs/converse";
import { writeSpec } from "./jobs/write";
import { verifySpec } from "./jobs/verify";
import { learnSpec } from "./jobs/learn";

const entries = loadClaudeCodeSources();
type Simple = Exclude<ClaudeCodeEntry, { job: "investigate" }>;
type Investigation = Extract<ClaudeCodeEntry, { job: "investigate" }>;
function of(job: "investigate"): Investigation[];
function of(job: Simple["job"]): Simple[];
function of(job: ClaudeCodeEntry["job"]) {
  return entries.filter((e) => e.job === job);
}

afterEach(() => vi.restoreAllMocks());

describe("Claude Code fixtures", () => {
  it("cover all seven jobs", () => {
    expect(new Set(entries.map((e) => e.job))).toEqual(new Set(JOBS));
  });

  it("are all on disk under their key, labelled", () => {
    for (const e of entries) {
      const calls = e.job === "investigate" ? investigateCalls(e) : [{ input: e.input }];
      for (const c of calls) {
        const file = fixturePath(path.join(process.cwd(), "fixtures", "ai"), e.job, fixtureKey(e.job, c.input));
        expect(fs.existsSync(file), `${e.name}: run npm run ai:fixtures`).toBe(true);
        expect(JSON.parse(fs.readFileSync(file, "utf8")).label).toBe("recorded in Claude Code");
      }
    }
  });
});

describe("replay", () => {
  it("understand", async () => {
    const { ai } = aiWorld();
    for (const e of of("understand")) {
      const r = await ai.understand(e.input as { text: string });
      expect(r.source).toBe("replay");
      expect(r.label).toBe("recorded in Claude Code");
      expect(r.output).toEqual(e.output);
    }
  });

  it("understand takes a voice note transcript exactly like text", async () => {
    const { ai } = aiWorld();
    const text = (of("understand")[1].input as { text: string }).text;
    const asText = await ai.understand({ text, source: "text" });
    const asVoice = await ai.understand({ text, source: "voice_note" });
    expect(asVoice.key).toBe(asText.key);
    expect(asVoice.output).toEqual(asText.output);
    expect(asVoice.source).toBe("replay");
  });

  it("investigate runs the loop over replayed steps until two findings agree", async () => {
    const { ai } = aiWorld();
    const e = of("investigate")[0];
    const results = e.steps.map((s) => s.result).filter(Boolean);
    let i = 0;
    const tools: ReadToolRunner = async () => results[i++]!;
    const r = await ai.investigate(e.request, tools);
    expect(r.stoppedBy).toBe("agreed");
    expect(r.steps).toBe(4);
    expect(r.side).toBe("razorpay");
    expect(r.confidence).toBe("sure");
    expect(r.labels).toEqual(["recorded in Claude Code"]);
    expect(r.findings.map((f) => f.evidenceRef)).toEqual(["pay_Fx01", "evt_Fx01", "ord_Fx01"]);
  });

  it("decide", async () => {
    const { ai } = aiWorld();
    for (const e of of("decide")) {
      const { options: _options, ...input } = e.input as Parameters<typeof ai.decide>[0] & { options: unknown };
      void _options;
      const r = await ai.decide(input);
      expect(r.source).toBe("replay");
      expect(r.output).toEqual(e.output);
      expect(canAct(r)).toBe(true);
    }
  });

  it("converse", async () => {
    const { ai } = aiWorld();
    for (const e of of("converse")) {
      const r = await ai.converse(e.input as Parameters<typeof ai.converse>[0], () => ({ status: "none" }));
      expect(r.source).toBe("replay");
      expect(r.output).toEqual(e.output);
    }
  });

  it("write", async () => {
    const { ai } = aiWorld();
    for (const e of of("write")) {
      const r = await ai.write(e.input as Parameters<typeof ai.write>[0]);
      expect(r.source).toBe("replay");
      expect(r.output).toEqual(e.output);
    }
  });

  it("verify", async () => {
    const { ai } = aiWorld();
    for (const e of of("verify")) {
      const r = await ai.verify((e.input as { reply: string }).reply);
      expect(r.source).toBe("replay");
      expect(r.output).toEqual(e.output);
    }
  });

  it("learn", async () => {
    const { ai } = aiWorld();
    for (const e of of("learn")) {
      const r = await ai.learn(e.input as Parameters<typeof ai.learn>[0]);
      expect(r.source).toBe("replay");
      expect(r.output).toEqual(e.output);
      expect(r.proposal?.status).toBe("proposed");
    }
  });

  it("logs every call in ai_calls", async () => {
    const { ai, calls } = aiWorld();
    const r = await ai.understand(of("understand")[0].input as { text: string });
    const rows = calls();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ job: "understand", mode: "replay", input_hash: r.key, valid: true, output: r.output });
  });
});

describe("a broken fixture", () => {
  it("with output that fails the schema is rejected and falls back to Unsure", async () => {
    const dir = copyFixtures(tmpDir());
    const input = of("understand")[0].input as { text: string };
    const file = fixturePath(dir, "understand", fixtureKey("understand", input));
    const f = JSON.parse(fs.readFileSync(file, "utf8"));
    f.output.amount = "about twelve hundred";
    f.output.intent = "give_me_money";
    fs.writeFileSync(file, JSON.stringify(f));

    const { ai, calls } = aiWorld({ fixturesDir: dir });
    const r = await ai.understand(input);
    expect(r.source).toBe("fallback");
    expect(r.fallbackReason).toBe("invalid_output");
    expect(r.output.confidence).toBe("unsure");
    expect(r.output.amount).toBeNull();
    expect(canAct(r)).toBe(false);
    expect(calls()[0].valid).toBe(false);
  });

  it("whose output breaks the job's guard is rejected", async () => {
    const dir = copyFixtures(tmpDir());
    const input = of("write")[0].input as Parameters<ReturnType<typeof aiWorld>["ai"]["write"]>[0];
    const file = fixturePath(dir, "write", fixtureKey("write", input));
    const f = JSON.parse(fs.readFileSync(file, "utf8"));
    f.output.draft = f.output.draft.replace("₹1,299", "₹1,399");
    fs.writeFileSync(file, JSON.stringify(f));

    const { ai } = aiWorld({ fixturesDir: dir });
    const r = await ai.write(input);
    expect(r.fallbackReason).toBe("guard_failed");
    expect(r.problems?.join()).toMatch(/1399/);
    expect(r.output.draft).toBeNull();
  });

  it("that is not valid JSON is rejected", async () => {
    const dir = copyFixtures(tmpDir());
    const input = of("verify")[0].input as { reply: string };
    fs.writeFileSync(fixturePath(dir, "verify", fixtureKey("verify", input)), "{ not json");
    const { ai } = aiWorld({ fixturesDir: dir });
    const r = await ai.verify(input.reply);
    expect(r.fallbackReason).toBe("invalid_output");
    expect(r.confirmed).toBe(false);
  });
});

describe("a replay miss", () => {
  it("returns Unsure, never acts, and is logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ai, calls } = aiWorld({ fixturesDir: tmpDir() });
    const r = await ai.decide({
      moment: "paid_no_order",
      case: { confidence: "sure" },
      findings: [],
      playbook: [],
      memory: [],
    });
    expect(r.source).toBe("fallback");
    expect(r.fallbackReason).toBe("replay_miss");
    expect(r.output).toMatchObject({ proposal: "escalate", confidence: "unsure" });
    expect(canAct(r)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("replay miss"));
    expect(calls()[0]).toMatchObject({ job: "decide", valid: false, output: { fallback: "replay_miss" } });
  });

  it("every job's fallback is Unsure and valid against its own schema", () => {
    for (const spec of [understandSpec, investigateStepSpec, decideSpec, converseSpec, writeSpec, verifySpec, learnSpec]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out = spec.fallback(undefined as any);
      expect(out.confidence, spec.job).toBe("unsure");
      expect(spec.schema.safeParse(out).success, spec.job).toBe(true);
    }
  });
});
