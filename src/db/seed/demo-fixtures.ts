/* eslint-disable @typescript-eslint/no-explicit-any -- fixture inputs and outputs are free-form JSON */
// Writes the AI fixtures the demo world needs (npm run ai:demo-fixtures).
// The demo's cases run through the real flows with the AI in replay, so every
// question they ask needs a recorded answer. Where the cast is new (Neha,
// Karan, a cookie box instead of a gym plan) the question is the same as one
// already recorded in Claude Code, with other names, amounts and times. This
// tool runs the demo world and a rehearsal of the story, and for each
// question with no answer it takes the nearest recorded one, carries over
// what differs (names, amounts, dates, times), checks the result against the
// job's schema and code guard, and writes it labelled "recorded in Claude
// Code". Read the printed answers before committing them.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_FIXTURES_DIR, writeFixture } from "@/ai/fixtures";
import { fixtureKey } from "@/ai/key";
import { converseSpec } from "@/ai/jobs/converse";
import { decideSpec } from "@/ai/jobs/decide";
import { investigateStepSpec } from "@/ai/jobs/investigate";
import { learnSpec } from "@/ai/jobs/learn";
import { understandSpec } from "@/ai/jobs/understand";
import { verifySpec } from "@/ai/jobs/verify";
import { writeSpec } from "@/ai/jobs/write";
import { JOBS, type JobName, type JobSpec } from "@/ai/types";
import { formatDate, formatMoney, formatTime } from "@/guards/format";
import { openMigratedDb } from "../client";
import { aiCalls } from "../schema";
import { seedDemo, type DemoWorld } from "./demo";

type Miss = { job: JobName; key: string; input: unknown };
const SPECS: Record<JobName, JobSpec<any, any>> = {
  understand: understandSpec, investigate: investigateStepSpec, decide: decideSpec, converse: converseSpec, write: writeSpec, verify: verifySpec, learn: learnSpec,
};

type Stored = { key: string; input: unknown; output: unknown };
const corpus = new Map<JobName, Stored[]>();
function load(job: JobName): Stored[] {
  let list = corpus.get(job);
  if (!list) {
    const dir = path.join(DEFAULT_FIXTURES_DIR, job);
    list = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Stored) : [];
    corpus.set(job, list);
  }
  return list;
}

// ---- Finding the nearest recorded question

const words = (v: unknown) => new Set(JSON.stringify(v).toLowerCase().split(/[^a-z0-9₹$£€]+/).filter((w) => w.length > 1));
function jaccard(a: Set<string>, b: Set<string>) {
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  return both / (a.size + b.size - both || 1);
}
// Questions are alike only when they have the same shape: the same kind of
// write, the same step of an investigation.
function sameShape(job: JobName, a: any, b: any): boolean {
  if (job === "write") return a.kind === b.kind && a.language === b.language && a.audience === b.audience;
  if (job === "investigate") {
    const tools = (x: any) => (x.history ?? []).map((h: any) => h.tool).join(",");
    return tools(a) === tools(b);
  }
  return true;
}
function nearest(job: JobName, input: unknown): Stored | null {
  const target = words(input);
  let best: Stored | null = null;
  let bestScore = -1;
  for (const f of load(job)) {
    if (!sameShape(job, f.input, input)) continue;
    const score = jaccard(words(f.input), target);
    if (score > bestScore) {
      bestScore = score;
      best = f;
    }
  }
  return best;
}

// ---- Carrying over what differs

const isEpoch = (n: number) => Number.isInteger(n) && n > 1.5e12 && n < 2.5e12;
const lcs = (a: string[], b: string[]) => {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  return dp;
};
// The runs of words that changed between two sentences.
function wordSwaps(a: string, b: string): [string, string][] {
  const x = a.split(/\s+/);
  const y = b.split(/\s+/);
  const dp = lcs(x, y);
  const out: [string, string][] = [];
  let i = 0;
  let j = 0;
  let from: string[] = [];
  let to: string[] = [];
  const flush = () => {
    if (from.length && to.length && from.length <= 4 && to.length <= 4) out.push([from.join(" "), to.join(" ")]);
    from = [];
    to = [];
  };
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      flush();
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) from.push(x[i++]);
    else to.push(y[j++]);
  }
  from.push(...x.slice(i));
  to.push(...y.slice(j));
  flush();
  return out;
}

function swaps(a: unknown, b: unknown, out: [string, string][]) {
  if (typeof a === "string" && typeof b === "string") {
    if (a === b) return;
    out.push([a, b]);
    if (a.includes(" ") || b.includes(" ")) out.push(...wordSwaps(a, b));
  } else if (typeof a === "number" && typeof b === "number") {
    if (a === b) return;
    if (isEpoch(a) && isEpoch(b)) {
      out.push([formatTime(a), formatTime(b)], [formatDate(a), formatDate(b)]);
    } else if (a % 100 === 0 && b % 100 === 0 && a > 0 && b > 0) {
      out.push([formatMoney(a), formatMoney(b)], [String(a / 100), String(b / 100)]);
      out.push([String(a / 100).replace(/\B(?=(\d{3})+(?!\d))/g, ","), String(b / 100).replace(/\B(?=(\d{3})+(?!\d))/g, ",")]);
    }
    out.push([String(a), String(b)]);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) swaps(a[i], b[i], out);
  } else if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of Object.keys(a)) if (k in (b as object)) swaps((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], out);
  }
}

function applyTo(value: unknown, pairs: [string, string][]): unknown {
  if (typeof value === "string") {
    let s = value;
    // Longest first, so a whole phrase wins over a word inside it.
    for (const [from, to] of pairs) {
      if (from.length < 2 || !s.includes(from)) continue;
      // A number only changes as a whole number: 12 never changes inside 1299.
      s = /^[\d.,]+$/.test(from) ? s.replace(new RegExp(`(?<![\\d.,])${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\d]|[.,]\\d)`, "g"), to) : s.split(from).join(to);
    }
    return s;
  }
  if (Array.isArray(value)) return value.map((v) => applyTo(v, pairs));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, applyTo(v, pairs)]));
  return value;
}

// Questions where no recorded one is close enough to learn from: answered here.
const OVERRIDES: { job: JobName; when: (input: any) => boolean; output: unknown | ((input: any) => unknown) }[] = [
  {
    // Priya's email in the demo: no amount, no time, no UTR. Worried, and it is the usual "paid, no order".
    job: "understand",
    when: (i) => i.text === "Money deducted but no order!!",
    output: { amount: null, rough_time: null, utr: null, payment_id: null, intent: "paid_no_order", language: "en", mood: "worried", legal_or_chargeback_words: [], confidence: "likely" },
  },
  {
    // Rahul's WhatsApp: Hinglish, charged twice for a ₹499 loaf.
    job: "understand",
    when: (i) => i.text === "Bhaiya banana bread ke 499 do baar kat gaye. Ek wapas kar do please.",
    output: { amount: 499, rough_time: null, utr: null, payment_id: null, intent: "paid_no_order", language: "hinglish", mood: "worried", legal_or_chargeback_words: [], confidence: "sure" },
  },
  {
    // "mil gaya" is "I got it": the order arrived.
    job: "verify",
    when: (i) => i.reply === "mil gaya, thanks",
    output: { status: "arrived", confidence: "sure" },
  },
  {
    // Refunding all of Priya's payment (not an extra one), in the Hinglish she wrote in.
    job: "write",
    when: (i) => i.kind === "refund_confirmation" && i.facts?.case?.situation === "B" && i.language === "hinglish",
    output: (i: any) => ({ draft: `Hi Priya, humne aapka ${i.facts.case.amount} refund kar diya hai. Yeh aapke bank ki usual speed se usi account mein aayega. Team Leafy Bakes`, confidence: "sure" }),
  },
];

export function synthesize(miss: Miss): { output: unknown; from: string; problems: string[] } | null {
  const override = OVERRIDES.find((o) => o.job === miss.job && o.when(miss.input));
  if (override) {
    const output = typeof override.output === "function" ? override.output(miss.input) : override.output;
    const parsed = SPECS[miss.job].schema.safeParse(output);
    const problems: string[] = parsed.success ? (SPECS[miss.job].guard?.(parsed.data, miss.input) ?? []) : ["override does not match the schema"];
    return { output, from: "written for the demo", problems };
  }
  const near = nearest(miss.job, miss.input);
  if (!near) return null;
  const pairs: [string, string][] = [];
  swaps(near.input, miss.input, pairs);
  const unique = [...new Map(pairs.map((p) => [p[0], p] as const)).values()].sort((x, y) => y[0].length - x[0].length);
  const output = applyTo(near.output, unique);
  const spec = SPECS[miss.job];
  const parsed = spec.schema.safeParse(output);
  if (!parsed.success) return { output, from: near.key, problems: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  const problems: string[] = spec.guard?.(parsed.data, miss.input) ?? [];
  return { output: parsed.data, from: near.key, problems };
}

// ---- Running the demo world and a rehearsal of the story, collecting what is missing

async function collectMisses(run: () => Promise<void>): Promise<Miss[]> {
  const found = new Map<string, Miss>();
  const warn = console.warn;
  process.env.RAY_AI_LOG_MISSES = "1";
  console.warn = (...args: unknown[]) => {
    const line = String(args[0] ?? "");
    if (line.startsWith("[ai-miss] ")) {
      const m = JSON.parse(line.slice("[ai-miss] ".length)) as Miss;
      found.set(`${m.job}:${m.key}`, m);
    } else if (!line.startsWith("[ai] replay miss")) warn(...args);
  };
  try {
    await run();
  } finally {
    console.warn = warn;
  }
  return [...found.values()];
}

// The story's first chapters, so the answers its taps need are recorded too.
async function rehearse(w: DemoWorld) {
  const { tap } = await import("@/surfaces/actions");
  const { openProposals } = await import("@/engine/orchestrator");
  const { eq } = await import("drizzle-orm");
  const { fireOutcome } = await import("@/flows/chargebacks/sim");
  const s = await import("../schema");
  const L = "m_leafy_bakes";
  const caseBy = (paymentId: string) => w.repo.cases.list(eq(s.cases.payment_id, paymentId)).at(-1)!;
  const choose = async (caseId: string, label: RegExp) => {
    const p = openProposals({ db: w.db, repo: w.repo, clock: w.a.clock }, caseId).find((x) => label.test(x.label));
    if (!p) throw new Error(`No "${label}" on ${caseId}`);
    await tap(w.engine, w.a, { caseId, choice: "approve", proposalId: p.id });
  };
  // A chapter that cannot run yet (its answers are still missing) is skipped this round.
  const chapter = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      console.log(`  (rehearsal: ${name} waits for its answers: ${e instanceof Error ? e.message.slice(0, 90) : e})`);
    }
  };
  // Chapter 5: Rahul's refund from the phone, through its 10-minute hold.
  await chapter("Rahul", async () => {
    await choose(caseBy("pay_LB1235RAHUL2").id, /^Refund the extra/);
    await w.engine.advanceBy(11 * 60_000);
  });
  // Chapter 7: Neha's reply goes out with the evidence.
  await chapter("Neha", async () => {
    await choose(caseBy("pay_LB1190NEHA").id, /^Contest/);
  });
  // Chapter 8: Karan picks the pause and says yes.
  await chapter("Karan", async () => {
    const karan = w.repo.cases.list(eq(s.cases.moment, "subscription")).sort((x, y) => y.opened_at - x.opened_at)[0];
    await choose(karan.id, /pause/i);
    await w.engine.receiveMessage({ merchantId: L, channel: "whatsapp", from: "+919800000131", body: "Yes please, pause it" });
  });
  // Chapter 3 and 4: Priya's order is marked paid; next morning she says it arrived.
  await chapter("Priya", async () => {
    await choose(caseBy("pay_LB1234PRIYA").id, /^Mark paid/);
    await w.engine.advanceBy(23 * 3_600_000);
    await w.engine.receiveMessage({ merchantId: L, channel: "email", from: "priya.sharma@example.com", body: "mil gaya, thanks" });
  });
  // Chapter 7: the duplicate chargeback's Stop window has passed; the bank rules.
  await chapter("Sanjay", async () => {
    await fireOutcome(w.a, L, "disp_LB_sanjay", "won");
  });
}

export async function writeDemoFixtures(log: (line: string) => void = console.log): Promise<number> {
  const files = new Map<string, string>(); // key -> file written this run
  let used = new Set<string>();
  // Answers written in a round whose question never comes up in the finished world (a
  // draft asked while a case was still Unsure) are removed at the end.
  const prune = () => {
    let kept = 0;
    for (const [key, file] of files) {
      if (used.has(key)) kept++;
      else fs.rmSync(file, { force: true });
    }
    return kept;
  };
  for (let round = 1; round <= 25; round++) {
    const db = openMigratedDb(":memory:");
    const misses = await collectMisses(async () => {
      await seedDemo(db, { rehearse });
      used = new Set(db.select().from(aiCalls).all().map((c) => c.input_hash));
    });
    db.$client.close();
    if (misses.length === 0) {
      log(`Round ${round}: nothing missing.`);
      return prune();
    }
    let progress = 0;
    for (const m of misses) {
      const made = synthesize(m);
      if (!made) {
        log(`  no recorded ${m.job} to learn from (${m.key})`);
        continue;
      }
      if (made.problems.length) {
        log(`  ${m.job} ${m.key} from ${made.from}: ${made.problems.join("; ")}`);
        log(`    input: ${JSON.stringify(m.input).slice(0, 400)}`);
        log(`    output: ${JSON.stringify(made.output).slice(0, 400)}`);
        continue;
      }
      const file = writeFixture(DEFAULT_FIXTURES_DIR, { job: m.job, label: "recorded in Claude Code", promptVersion: SPECS[m.job].prompt.version, model: null, input: m.input, output: made.output });
      files.set(fixtureKey(m.job, m.input), file);
      corpus.delete(m.job);
      progress++;
      log(`  ${m.job} ${fixtureKey(m.job, m.input)} (from ${made.from}): ${JSON.stringify(made.output).slice(0, 300)}`);
    }
    log(`Round ${round}: wrote ${progress} of ${misses.length}.`);
    if (progress === 0) return prune();
  }
  return prune();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void JOBS;
  writeDemoFixtures().then((n) => console.log(`Wrote ${n} fixtures labelled "recorded in Claude Code".`));
}
