// Step 6: the dummy specialist's case shows on every surface, a tap on the
// WhatsApp card updates the case page, every surface renders in both views,
// simulated systems carry the Simulated tag, and no screen shows a banned
// word.
import { BladeProvider } from "@razorpay/blade/components";
import { bladeTheme } from "@razorpay/blade/tokens";
import { eq } from "drizzle-orm";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seededAdapters } from "@/adapters/test-helpers";
import { bannedWordsIn, hasEmDash } from "@/ai/grounding";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import { buildRegistry } from "@/engine";
import { createDummySpecialist } from "@/engine/dummy-specialist";
import { createEngine, type Engine } from "@/engine/engine";
import { createRegistry, type Specialist } from "@/engine/specialist";
import { guardedCall, setKillSwitch } from "@/guards";
import { letRayFix, requestChange, setRuleStatus, setSetting, tap, undo } from "./actions";
import { readSettings } from "./playbook";
import { buyerInbox, callScreen, customerInbox, storeAdmin } from "./sims";
import { alertsView, approvalCards, caseView, digestView, inboxView, merchantView, nextDigestAt, playbookView } from "./views";
import { KILL_SWITCH_BANNER, SIMULATED } from "./words";
import { ViewProvider, type View } from "@/ui/view";
import { Alerts } from "@/ui/merchant/alerts";
import { CasePage } from "@/ui/merchant/case-page";
import { Digest } from "@/ui/merchant/digest";
import { Inbox } from "@/ui/merchant/inbox";
import { PageShell } from "@/ui/merchant/page-shell";
import { Playbook } from "@/ui/merchant/playbook";
import { WhatsAppThread } from "@/ui/merchant/whatsapp";
import { CallScreen } from "@/ui/sim/calls";
import { PeopleInbox } from "@/ui/sim/inbox";
import { SimBar } from "@/ui/sim/sim-bar";
import { StoreAdmin } from "@/ui/sim/store";
import { MerchantTopBar } from "@/ui/merchant/top-bar";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh() {}, push() {} }),
  usePathname: () => "/merchant/m_leafy_bakes",
  useServerInsertedHTML: () => {},
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const LEAFY = "m_leafy_bakes";
const PRIYA = "+919800000101";
const PAY = "pay_LB1234PRIYA";
const MIN = 60_000;

let a: ReturnType<typeof seededAdapters> | undefined;
let engine: Engine | undefined;
afterEach(() => {
  engine?.stop();
  a?.db.$client.close();
  a = engine = undefined;
});

// The dummy flow up to Needs you: Razorpay's payment update, then Priya writes.
async function dummyCase(spec: Specialist = createDummySpecialist()) {
  a = seededAdapters();
  engine = createEngine({ db: a.db, clock: a.clock, adapters: a, registry: createRegistry([spec]) });
  await a.webhooks.emit({ merchantId: LEAFY, event: "payment.captured", paymentId: PAY });
  await engine.receiveMessage({ merchantId: LEAFY, channel: "whatsapp", from: PRIYA, body: "I paid but my order still says pending" });
  const repo = createRepository(a.db);
  const caseId = repo.cases.list(eq(s.cases.payment_id, PAY))[0].id;
  expect(repo.cases.get(caseId)?.state).toBe("waiting_merchant");
  return { a, engine, repo, caseId };
}

// Tries mark_paid under a playbook row as if it were a rule; returns the
// guard failure codes.
async function checkApproval(ad: NonNullable<typeof a>, caseId: string, ruleId: string) {
  const r = await guardedCall(
    "mark_paid",
    { order_id: "so_leafy_1234", payment_id: PAY },
    { adapters: ad, caseId, approval: { by: "rule", ruleId, evidenceRef: ruleId } },
  );
  return r.status === "blocked" ? r.failures.map((f) => `${f.guard}:${f.code}`) : [r.status];
}

function render(view: View, node: ReactNode): string {
  return renderToStaticMarkup(
    <BladeProvider themeTokens={bladeTheme} colorScheme="light">
      <ViewProvider initial={view}>{node}</ViewProvider>
    </BladeProvider>,
  );
}

// What a person reads: the text, without tags, styles or attributes.
const textOf = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

function merchantScreens(caseId: string) {
  const ad = a!;
  const m = merchantView(ad, LEAFY);
  const shell = (n: ReactNode) => <PageShell killSwitch={m.killSwitch !== null}>{n}</PageShell>;
  const alerts = alertsView(ad, LEAFY);
  return {
    alerts: shell(<Alerts merchant={alerts.merchant} alerts={alerts.alerts} />),
    inbox: shell(<Inbox merchantId={LEAFY} inbox={inboxView(ad, LEAFY)} />),
    case: shell(<CasePage v={caseView(ad, caseId)} />),
    whatsapp: shell(<WhatsAppThread cards={approvalCards(ad, LEAFY)} digest={digestView(ad, LEAFY)} merchantId={LEAFY} killSwitch={m.killSwitch !== null} />),
    digest: shell(<Digest d={digestView(ad, LEAFY)} merchantId={LEAFY} />),
    playbook: shell(<Playbook p={playbookView(ad, LEAFY)} />),
  };
}

function simScreens() {
  const ad = a!;
  return {
    customers: <PeopleInbox title="Customer inbox" kind="customer" people={customerInbox(ad)} />,
    buyers: <PeopleInbox title="Buyer inbox" kind="buyer" people={buyerInbox(ad)} />,
    store: <StoreAdmin stores={storeAdmin(ad)} failures={[...s.STORE_FAILURE_MODES]} />,
    calls: <CallScreen v={callScreen(ad)} />,
  };
}

describe("the dummy case on every surface", () => {
  it("shows in alerts, the inbox, the case page, the WhatsApp card and the digest", async () => {
    const { caseId } = await dummyCase();
    const ad = a!;

    const alert = alertsView(ad, LEAFY).alerts.find((x) => x.caseId === caseId)!;
    expect(alert).toMatchObject({ name: "Priya Sharma", amount: "₹1,299", moment: "Paid, no order" });

    const inbox = inboxView(ad, LEAFY);
    expect(inbox.waitingOnYou).toBe("₹1,299 waiting on you");
    expect(inbox.tabs.map((t) => t.label)).toEqual(["Needs you", "RAY is handling", "Closed"]);
    expect(inbox.tabs[0].rows).toMatchObject([{ id: caseId, name: "Priya Sharma", amount: "₹1,299", state: { label: "Needs you" }, confidence: { label: "Sure" } }]);

    const v = caseView(ad, caseId);
    expect(v).toMatchObject({ name: "Priya Sharma", amount: "₹1,299", moment: "Paid, no order", state: { label: "Needs you", tone: "notice" } });
    expect(v.confidence).toMatchObject({ label: "Sure", reason: "Customer gave the details" });
    expect(v.side).toEqual({ label: "Your side", note: "Here's the fix." });
    expect(v.findings.length).toBeGreaterThan(0);
    for (const f of v.findings) {
      expect(f.ok).toBe(true);
      expect(f.evidenceRef).toBeTruthy();
      expect(["Razorpay", "Store", "Customer", "Bank"]).toContain(f.source);
    }
    expect(v.conversation).toMatchObject([{ direction: "in", from: "Priya Sharma", body: "I paid but my order still says pending" }]);
    expect(v.yourCall.primary).toMatchObject({ label: "Mark paid & ship", covered: false });
    expect(v.yourCall.secondary.map((p) => p.label)).toEqual(["Refund the customer"]);
    expect(v.yourCall.sendFrom).toBe("RAY will send this from Leafy Bakes's own number or inbox");
    expect(v.promiseLine).toMatch(/^Priya was told to expect a reply by \d{1,2}:\d{2} (AM|PM)$/);
    expect(v.timeline.some((st) => st.failed)).toBe(true);

    expect(approvalCards(ad, LEAFY)).toMatchObject([{ caseId, primary: { label: "Mark paid & ship" } }]);
    const digest = digestView(ad, LEAFY);
    expect(digest).toMatchObject({ count: 1, total: "₹1,299", details: [{ n: 1, caseId, line: "Priya Sharma · ₹1,299 · Paid, no order" }] });
  });

  it("a tap on the WhatsApp card goes through handleEvent and updates the case page", async () => {
    const { caseId, repo } = await dummyCase();
    const card = approvalCards(a!, LEAFY)[0];
    const r = await tap(engine!, a!, { caseId, choice: "approve", proposalId: card.primary.id });
    expect(r.outcome).toBe("handled");
    expect(repo.caseEvents.listByCase(caseId).some((e) => e.type === "approval" && e.payload.choice === "approve")).toBe(true);

    const v = caseView(a!, caseId);
    expect(v.state.label).toBe("Checking it worked");
    expect(v.card).toBeNull();
    expect(v.yourCall.canTap).toBe(false);
    expect(v.timeline.map((st) => st.label)).toContain("You approved");
    expect(approvalCards(a!, LEAFY)).toEqual([]);
    expect(textOf(render("desktop", <CasePage v={v} />))).toContain("Checking it worked");

    await engine!.advanceBy(30 * MIN);
    expect(inboxView(a!, LEAFY).tabs[2].rows.map((x) => x.state.label)).toEqual(["Resolved"]);
  });

  it("Change records the merchant's words on the case and the same card comes back", async () => {
    const { caseId } = await dummyCase();
    requestChange(a!, { caseId, text: "Refund instead" });
    const cards = approvalCards(a!, LEAFY);
    expect(cards).toHaveLength(1);
    expect(cards[0].changeAsked).toBe("Refund instead");
    expect(caseView(a!, caseId).events.map((e) => e.what)).toContain("You asked: Refund instead");
  });

  it("the getEngine registry uses the dummy until a flow handles paid_no_order, and RAY_DUMMY_FLOW=off turns it off", () => {
    expect(buildRegistry({}).forMoment("paid_no_order")?.id).toBe("dummy");
    expect(buildRegistry({ RAY_DUMMY_FLOW: "off" }).all()).toEqual([]);
  });
});

describe("both views, Simulated tags and words", () => {
  it("every merchant surface renders in Phone and Desktop, with that view's layout", async () => {
    const { caseId } = await dummyCase();
    const screens = merchantScreens(caseId);
    for (const [name, node] of Object.entries(screens)) {
      const phone = render("phone", node);
      const desktop = render("desktop", node);
      expect(phone, name).toContain('data-view="phone"');
      expect(desktop, name).toContain('data-view="desktop"');
      expect(phone, name).not.toEqual(desktop);
    }
    const inboxDesktop = render("desktop", screens.inbox);
    const inboxPhone = render("phone", screens.inbox);
    expect(inboxDesktop).toContain("<table");
    expect(inboxPhone).not.toContain("<table");
    expect(inboxPhone).toContain("case-card");
    expect(render("desktop", screens.case)).toContain("panes-3");
    const casePhone = render("phone", screens.case);
    expect(casePhone).toContain("action-bar");
    // Phone: findings first, then the conversation.
    expect(casePhone.indexOf("What RAY found")).toBeLessThan(casePhone.indexOf("Conversation"));
    expect(render("phone", screens.whatsapp)).toContain("phone-frame");
    expect(render("desktop", screens.playbook)).toContain("cols-2");
  });

  it("every approval button shows Covered or Your call", async () => {
    const { caseId } = await dummyCase();
    const html = render("desktop", <CasePage v={caseView(a!, caseId)} />);
    const buttons = (textOf(html).match(/Mark paid & ship|Refund the customer/g) ?? []).length;
    const labels = (html.match(/approval-label (covered|your-call)/g) ?? []).length;
    expect(buttons).toBeGreaterThanOrEqual(2);
    // One under each button on the case page, one on the card.
    expect(labels).toBeGreaterThanOrEqual(3);
  });

  it("every simulated system carries the Simulated tag", async () => {
    const { caseId } = await dummyCase();
    for (const [name, node] of Object.entries(simScreens())) expect(textOf(render("desktop", node)), name).toContain(SIMULATED);
    const m = merchantScreens(caseId);
    for (const view of ["phone", "desktop"] as const) {
      expect(textOf(render(view, m.whatsapp))).toContain(SIMULATED);
      expect(textOf(render(view, m.digest))).toContain(SIMULATED);
    }
    // The WhatsApp card beside the case page.
    expect(textOf(render("desktop", m.case))).toContain(SIMULATED);
  });

  it("no merchant, customer or buyer screen shows a banned word or an em dash", async () => {
    const { caseId } = await dummyCase();
    const screens = { ...merchantScreens(caseId), ...simScreens() };
    for (const [name, node] of Object.entries(screens)) {
      for (const view of ["phone", "desktop"] as const) {
        const text = textOf(render(view, node));
        expect(bannedWordsIn(text), `${name} (${view})`).toEqual([]);
        expect(hasEmDash(text), `${name} (${view})`).toBe(false);
      }
    }
  });
});

describe("dev panel", () => {
  it("no merchant, customer or buyer screen links to the dev panel", async () => {
    const { caseId } = await dummyCase();
    const merchants = [{ id: LEAFY, name: "Leafy Bakes" }];
    const screens = {
      ...merchantScreens(caseId),
      ...simScreens(),
      merchantBar: <MerchantTopBar merchantId={LEAFY} merchants={merchants} />,
      simBar: <SimBar />,
    };
    for (const [name, node] of Object.entries(screens)) {
      for (const view of ["phone", "desktop"] as const) {
        expect(render(view, node), `${name} (${view})`).not.toMatch(/href="\/dev(["/?#])/);
      }
    }
  });
});

describe("interaction rules", () => {
  it("kill switch: action buttons disappear, the banner shows, reading still works", async () => {
    const { caseId } = await dummyCase();
    setKillSwitch(a!.db, a!.clock, { merchantId: LEAFY }, true);
    const v = caseView(a!, caseId);
    expect(v.yourCall.canTap).toBe(false);
    expect(v.card).toBeNull();
    const screens = merchantScreens(caseId);
    const text = textOf(render("desktop", screens.case));
    expect(text).toContain(KILL_SWITCH_BANNER);
    expect(text).not.toContain("Mark paid & ship");
    expect(text).toContain("Priya Sharma");
    expect(textOf(render("phone", screens.whatsapp))).not.toContain("Approve");
  });

  it("Unsure shows only the question, never an action button", async () => {
    const { caseId, repo } = await dummyCase();
    repo.cases.update(caseId, { confidence: "unsure" });
    const v = caseView(a!, caseId);
    expect(v.yourCall).toMatchObject({ unsure: true, primary: null, secondary: [] });
    expect(v.card).toBeNull();
    const text = textOf(render("desktop", <CasePage v={v} />));
    expect(text).not.toContain("Mark paid & ship");
    expect(text).toContain("RAY isn't sure yet");
  });

  it("a held refund shows on the case page and the inbox row with a countdown in words, and Undo cancels it", async () => {
    const refunding: Specialist = {
      ...createDummySpecialist(),
      async proposeActions() {
        return [{ id: "prop_refund", label: "Refund ₹1,299", tool: "refund", args: { payment_id: PAY, amount: 129_900 }, covered: false }];
      },
      async onApproval(ctx, kase, approval) {
        await guardedCall("refund", { payment_id: PAY, amount: 129_900 }, { adapters: ctx.adapters!, caseId: kase.id, approval });
        return { to: "verifying", reason: "Refund on hold", timers: [{ kind: "verify_check", inMs: 30 * MIN }] };
      },
    };
    const { caseId, repo } = await dummyCase(refunding);
    await tap(engine!, a!, { caseId, choice: "approve", proposalId: "prop_refund" });
    a!.clock.advance(18_000);

    const hold = caseView(a!, caseId).holds[0];
    expect(hold).toMatchObject({ text: "Refunding ₹1,299", control: "Undo", remaining: { clock: "9:42", words: "9 min 42 s" } });
    expect(inboxView(a!, LEAFY).tabs[1].rows[0].holds).toHaveLength(1);
    const text = textOf(render("desktop", <CasePage v={caseView(a!, caseId)} />));
    expect(text).toContain("Refunding ₹1,299 in 9:42");
    expect(text).toContain("9 min 42 s left");

    expect((await undo(a!, LEAFY, hold.actionId)).ok).toBe(true);
    expect(repo.actions.get(hold.actionId)?.status).toBe("undone");
    expect(caseView(a!, caseId).holds).toEqual([]);
  });

  it("Let RAY fix these switches RAY on and proposes the setup rules, off until approved", async () => {
    a = seededAdapters();
    const crumb = "m_crumb_co";
    expect(alertsView(a, crumb).merchant.rayOn).toBe(false);
    expect(textOf(render("desktop", <Alerts merchant={merchantView(a, crumb)} alerts={[]} />))).toContain("Let RAY fix these");
    letRayFix(a, crumb);
    expect(merchantView(a, crumb).rayOn).toBe(true);
    const rules = playbookView(a, crumb).moments.flatMap((m) => m.rules);
    expect(rules.map((r) => r.status)).toEqual(["proposed"]);
    setRuleStatus(a, { merchantId: crumb, ruleId: rules[0].id, status: "approved" });
    expect(playbookView(a, crumb).moments.flatMap((m) => m.rules)[0].status).toBe("approved");
  });

  it("playbook settings are stored, read back, and can never approve an action", async () => {
    const { caseId } = await dummyCase();
    expect(readSettings(a!.db, LEAFY, "paid_no_order")).toEqual({ tone: "Warm", signOff: "Team Leafy Bakes", sendFrom: "merchant_inbox", autoMessages: false });
    const row = setSetting(a!, { merchantId: LEAFY, moment: "paid_no_order", key: "sign_off", value: "Love, Leafy Bakes" });
    setSetting(a!, { merchantId: LEAFY, moment: "paid_no_order", key: "send_from", value: "via_razorpay" });
    expect(readSettings(a!.db, LEAFY, "paid_no_order")).toMatchObject({ signOff: "Love, Leafy Bakes", sendFrom: "via_razorpay" });
    expect(caseView(a!, caseId).yourCall.sendFrom).toBe("RAY will send this from Leafy Bakes via Razorpay");
    // Settings don't show as rules, and a setting row can't stand in for one.
    expect(playbookView(a!, LEAFY).moments[0].rules.every((r) => r.id !== row.id)).toBe(true);
    expect(await checkApproval(a!, caseId, row.id)).toContain("approval:rule_not_approved");
  });

  it("the digest goes out at 10 AM and 6 PM", () => {
    const at = (iso: string) => Date.parse(iso);
    expect(nextDigestAt(at("2026-10-12T09:00:00+05:30"))).toBe(at("2026-10-12T10:00:00+05:30"));
    expect(nextDigestAt(at("2026-10-12T10:00:00+05:30"))).toBe(at("2026-10-12T18:00:00+05:30"));
    expect(nextDigestAt(at("2026-10-12T19:00:00+05:30"))).toBe(at("2026-10-13T10:00:00+05:30"));
  });
});

describe("voice on the screens (Step 5b)", () => {
  it("shows the voice note bubble, the Call card and the pre-call notice, Simulated, with no banned words", async () => {
    const { a: ad, engine: eng, repo, caseId } = await dummyCase();
    await eng.receiveVoiceNote({ merchantId: LEAFY, from: PRIYA, sampleId: "priya_hinglish" });
    await ad.messaging.send({ merchantId: LEAFY, caseId, channel: "whatsapp", to: PRIYA, senderMode: "merchant_inbox", body: "We can see your payment. You'll hear from us soon." });
    ad.voice.setCallSim(PRIYA, { outcome: "busy" });
    const call = await guardedCall(
      "place_call",
      { kind: "paid_no_order_follow_up", to: PRIYA, opening: "Hi Priya, this is Leafy Bakes about your ₹1,299 payment this morning." },
      { adapters: ad, caseId },
    );
    expect(call.status).toBe("done");
    repo.timers.insert({ id: "tmr_call_ui", case_id: caseId, kind: "call", due_at: ad.clock.now() + 60 * MIN });

    for (const view of ["phone", "desktop"] as const) {
      const casePage = textOf(render(view, <CasePage v={caseView(ad, caseId)} />));
      expect(casePage).toContain("paisa kat gaya");
      expect(casePage).toContain("WhatsApp voice note");
      expect(casePage).toMatch(/Call to Priya · \d+ s Simulated Busy/);
      expect(casePage).toContain("RAY will call Priya at");
      expect(casePage).toContain("Cancel call");
      const inbox = textOf(render(view, <PeopleInbox title="Customer inbox" kind="customer" people={customerInbox(ad)} voiceSamples={[{ id: "priya_hinglish", label: "Priya" }]} />));
      expect(inbox).toContain("paisa kat gaya");
      expect(inbox).toMatch(/Call to Priya · \d+ s Simulated Busy/);
      const calls = textOf(render(view, <CallScreen v={callScreen(ad)} />));
      expect(calls).toContain("Simulated");
      expect(calls).toContain("Busy");
      for (const page of [casePage, inbox, calls]) {
        expect(bannedWordsIn(page)).toEqual([]);
        expect(hasEmDash(page)).toBe(false);
      }
    }
  });
});
