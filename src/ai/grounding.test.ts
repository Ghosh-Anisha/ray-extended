// Rule 6 (every number in a draft is in the case), the banned words from
// design language section 1, and the write prompt carrying sections 1 and 2.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BANNED_WORDS, bannedWordsIn, ungroundedNumbers } from "./grounding";
import { draftProblems, type WriteInput } from "./jobs/write";
import { createMasker } from "./mask";
import { designLanguageSections1And2, writePrompt } from "./prompts/write";
import { aiWorld, scriptedClient, tmpDir } from "./test-helpers";

const facts = { amount: "₹1,299", paid_at: "7:52 PM", paid_on: "6 Oct", utr_last4: "4821", order_number: "#1234", stock: 12 };
const customerFirst = (draft: string): Pick<WriteInput, "audience" | "first_customer_message" | "facts"> & { draft: string } => ({
  audience: "customer",
  first_customer_message: true,
  facts,
  draft,
});

describe("grounding check", () => {
  it("passes a draft whose numbers are all in the case", () => {
    expect(ungroundedNumbers("We got ₹1,299 at 7:52 PM on 6 Oct, UTR ending 4821, order #1234. 12 in stock.", facts)).toEqual([]);
    expect(ungroundedNumbers("Refund 1299", facts)).toEqual([]);
  });

  it("fails a draft that contains a number not in the case", () => {
    expect(ungroundedNumbers("We got ₹1,399 at 7:52 PM", facts)).toEqual(["1399"]);
    expect(ungroundedNumbers("You'll hear from us by 9:00 PM", facts)).toEqual(["9:00"]);
    expect(ungroundedNumbers("Refund in 5 days", facts)).toEqual(["5"]);
  });

  it("fails the write job's draft when it adds a number", async () => {
    const s = scriptedClient(() => ({ draft: "Hi, we got your ₹1,299. Refund of ₹200 coming.", confidence: "sure" }));
    const { ai } = aiWorld({ mode: "live", client: s.client, fixturesDir: tmpDir() });
    const r = await ai.write({ audience: "customer", kind: "customer_update", first_customer_message: false, facts, tone: "warm", language: "en" });
    expect(r.fallbackReason).toBe("guard_failed");
    expect(r.problems).toEqual(["numbers not in the case: 200"]);
    expect(r.output.draft).toBeNull();
  });
});

describe("banned words", () => {
  const writeFixtures = fs
    .readdirSync(path.join(process.cwd(), "fixtures", "ai", "write"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(process.cwd(), "fixtures", "ai", "write", f), "utf8")));

  it("no draft in the write fixtures contains a banned word or an em dash", () => {
    expect(writeFixtures.length).toBeGreaterThan(0);
    for (const f of writeFixtures) {
      if (f.input.audience === "developer" || !f.output.draft) continue;
      expect(bannedWordsIn(f.output.draft), f.key).toEqual([]);
      expect(f.output.draft).not.toContain("—");
    }
  });

  it("a draft with a banned word fails, except in the developer brief", () => {
    const draft = "Our webhook failed, so the order for ₹1,299 is stuck.";
    expect(draftProblems(draft, customerFirst(draft))).toContain("banned words: webhook");
    expect(draftProblems(draft, { ...customerFirst(draft), audience: "developer", first_customer_message: false })).toEqual([]);
  });

  it("catches every word on the list, any case", () => {
    for (const w of BANNED_WORDS) expect(bannedWordsIn(`Note: ${w.toUpperCase()} here`), w).toEqual([w]);
    expect(bannedWordsIn("You won’t be charged twice")).toEqual(["you won't be charged twice"]);
  });

  it("fails an em dash and a link in a first message to a customer", () => {
    expect(draftProblems("Got ₹1,299 — thanks", customerFirst(""))).toContain("has an em dash");
    expect(draftProblems("Paid ₹1,299? See https://pay.example.com/x", customerFirst(""))).toContain("first message to a customer has a link");
  });
});

describe("write prompt", () => {
  it("includes design language sections 1 and 2 verbatim, and not section 3", () => {
    const sections = designLanguageSections1And2();
    expect(sections.startsWith("## 1. Words and states")).toBe(true);
    expect(sections).toContain("## 2. RAY's voice");
    expect(sections).toContain("### Words never shown to merchants or customers");
    expect(sections).not.toContain("## 3. Look");
    expect(writePrompt.system).toContain(sections);
  });

  it("every prompt lives in its own versioned file", () => {
    const dir = path.join(process.cwd(), "src", "ai", "prompts");
    for (const job of ["understand", "investigate", "decide", "converse", "write", "verify", "learn"]) {
      const src = fs.readFileSync(path.join(dir, `${job}.ts`), "utf8");
      expect(src).toMatch(new RegExp(`version: "${job}\\.v\\d+"`));
    }
  });
});

describe("PII masking", () => {
  it("masks and restores names, phones, emails and card numbers, leaving UTRs and amounts", () => {
    const m = createMasker(["Ravi Kumar", "Ravi"]);
    const input = { text: "Ravi Kumar (ravi@example.in, 9876543210) paid 2499 by card 5500 0000 0000 0004, UTR 452606882553. Ravi again." };
    const masked = m.mask(input);
    expect(masked.text).toBe("[NAME_1] ([EMAIL_1], [PHONE_1]) paid 2499 by card [CARD_1], UTR 452606882553. [NAME_2] again.");
    expect(m.unmask(masked)).toEqual(input);
  });
});
