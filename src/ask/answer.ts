// Ask RAY: answers from the merchant's own rows. Every number comes from the
// database (cases, payments, refunds, disputes, invoices) and is cited with a
// link to the cases it came from. Nothing here calls a model, so it behaves
// the same in replay, live and record mode, and nothing in a customer message
// is ever read as an instruction. A rule request becomes a rule card; any
// other request gets the fallback with chips.
import { and, eq, gte, ne } from "drizzle-orm";
import type { Adapters } from "@/adapters";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import { caseRef } from "@/surfaces/refs";
import { hoursLabel, merchantStats, rupees } from "@/surfaces/stats";
import { money } from "@/surfaces/format";
import { caseView, inboxView, playbookView, type CaseRow } from "@/surfaces/views";
import { capabilities, type Capability } from "./capabilities";
import { CASE_CHIPS, FALLBACK_CHIPS, STARTER_CHIPS } from "./chips";
export { CASE_CHIPS, FALLBACK_CHIPS, STARTER_CHIPS };
import { describePlan, parseRuleRequest, type RuleCardData } from "./rules";

export type Cite = { label: string; href: string };
export type AskReply = {
  kind: "answer" | "rule" | "capabilities" | "fallback";
  text: string;
  bullets: string[];
  cites: Cite[];
  rule: RuleCardData | null;
  capabilities: Capability[];
  chips: string[];
};

const DAY = 24 * 60 * 60 * 1000;
const reply = (r: Partial<AskReply> & { text: string }): AskReply => ({ kind: "answer", bullets: [], cites: [], rule: null, capabilities: [], chips: [], ...r });
const norm = (t: string) => t.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();
const has = (t: string, re: RegExp) => re.test(t);

const fallback = (): AskReply =>
  reply({
    kind: "fallback",
    text: "I can't answer that from this demo. Ask about a seeded case or payment, cases waiting on you, refunds by product, or rules. I don't have a general-purpose investigator or connected bank, settlement or supplier records.",
    chips: FALLBACK_CHIPS,
  });

function citeCase(a: Adapters, merchantId: string, r: Pick<CaseRow, "id" | "name" | "amount">): Cite {
  return { label: `#${caseRef(a, r.id)} · ${r.name} · ${r.amount}`, href: `/merchant/${merchantId}/cases/${r.id}` };
}

function allRows(a: Adapters, merchantId: string) {
  return inboxView(a, merchantId).tabs.flatMap((t) => t.rows.map((row) => ({ row, tab: t.key })));
}

// ---- Questions

function whatsWaiting(a: Adapters, merchantId: string): AskReply {
  const view = inboxView(a, merchantId);
  const rows = view.tabs.find((t) => t.key === "needs_you")!.rows;
  if (rows.length === 0) return reply({ text: "You're all caught up. Nothing needs your tap right now.", bullets: ["Basis: no seeded cases are currently in the Needs you state."], chips: ["What can you do?"] });
  return reply({
    text: `${rows.length} case${rows.length === 1 ? " needs" : "s need"} your tap. Case amounts are shown individually because their bases may differ.`,
    bullets: rows.map((r) => `${r.name} · ${r.summary} · ${r.amount}`),
    cites: rows.map((r) => citeCase(a, merchantId, r)),
    chips: ["Why did Priya's order not show up?", "What can you do?"],
  });
}

// The story of one case: the cause, what RAY checked, and what comes next.
function aboutCase(a: Adapters, merchantId: string, caseId: string, lead?: string): AskReply {
  const kase = createRepository(a.db).cases.get(caseId);
  if (!kase || kase.merchant_id !== merchantId) return fallback();
  const v = caseView(a, caseId);
  const bullets = v.findings.slice(0, 5).map((f) => `${f.ok ? "✓" : "✗"} ${f.text} (${f.source})`);
  const next = v.yourCall.canTap && v.yourCall.primary ? `Next: ${v.yourCall.primary.label}, ${v.yourCall.primary.covered ? "Covered" : "Your call"}.` : v.promiseLine ? v.promiseLine : "Nothing needs your tap on this one.";
  const side = v.side ? `${v.side.label}. ${v.side.note}` : "RAY is still checking whose side this is.";
  return reply({
    text: `${lead ?? `${v.name}, ${v.amount}`}: ${side}`,
    bullets: [...bullets, next],
    cites: [{ label: `#${caseRef(a, caseId)} · ${v.name} · ${v.amount}`, href: `/merchant/${merchantId}/cases/${caseId}` }],
    chips: CASE_CHIPS.filter((c) => !c.startsWith("What did")),
  });
}

function customerAnswer(a: Adapters, merchantId: string, q: string): AskReply | null {
  const rows = allRows(a, merchantId).map((x) => x.row);
  const hit = rows.find((r) => {
    const first = r.name.split(/[\s.]+/)[0]!.toLowerCase();
    return first.length >= 3 && new RegExp(`\\b${first.replace(/[^a-z0-9]/g, "")}`).test(q);
  });
  return hit ? aboutCase(a, merchantId, hit.id) : null;
}

function refundsByProduct(a: Adapters, merchantId: string): AskReply {
  const since = a.clock.now() - 30 * DAY;
  const refunds = a.db
    .select()
    .from(s.rzpRefunds)
    .where(and(eq(s.rzpRefunds.merchant_id, merchantId), gte(s.rzpRefunds.created_at, since), ne(s.rzpRefunds.status, "failed")))
    .all();
  const orders = a.db.select().from(s.storeOrders).where(eq(s.storeOrders.merchant_id, merchantId)).all();
  const byPayment = new Map(orders.filter((o) => o.payment_id).map((o) => [o.payment_id!, o]));
  const totals = new Map<string, { amount: number; n: number }>();
  let unmatched = 0;
  for (const r of refunds) {
    const order = byPayment.get(r.payment_id);
    const item = order?.items[0]?.name;
    if (!item) {
      unmatched += r.amount;
      continue;
    }
    const t = totals.get(item) ?? { amount: 0, n: 0 };
    totals.set(item, { amount: t.amount + r.amount, n: t.n + 1 });
  }
  if (refunds.length === 0) return reply({ text: "No refunds in the last 30 days.", bullets: ["Basis: checked the seeded refund records for this 30-day window; none were found."], chips: STARTER_CHIPS.slice(0, 2) });
  const list = [...totals].sort((x, y) => y[1].amount - x[1].amount);
  const total = refunds.reduce((sum, r) => sum + r.amount, 0);
  return reply({
    text: `${refunds.length} refund${refunds.length === 1 ? "" : "s"} in the last 30 days, ${money(total)} in all, by product (the first item on the order):`,
    bullets: [
      `Basis: seeded refund records from the last 30 days; grouped by the first item on the linked store order. ${unmatched ? "Refunds without a linked order are listed separately." : ""}`.trim(),
      ...list.map(([name, t]) => `${name}: ${money(t.amount)} (${t.n})`),
      ...(unmatched ? [`No order found: ${money(unmatched)}`] : []),
    ],
    chips: ["What's waiting on me?"],
  });
}

function numbers(a: Adapters, merchantId: string, q: string): AskReply | null {
  const st = merchantStats(a, merchantId);
  const rows = allRows(a, merchantId);
  const casesOf = (momentKey: string, tabs?: string[]) => rows.filter((x) => x.row.momentKey === momentKey && (!tabs || tabs.includes(x.tab))).map((x) => x.row);
  if (has(q, /\b(save|saved|saving|recovered|kept)\b/)) {
    const closed = rows.filter((x) => x.tab === "closed").map((x) => x.row).slice(0, 5);
    return reply({
      text: `Demo cases marked saved total ${rupees(st.saved.amount)} in the last 30 days. This is not verified recovered revenue.`,
      bullets: [`${st.closed.count} cases closed, ${st.closed.byRay} marked as handled by RAY`, `${hoursLabel(st.timeSavedMinutes)} estimated from fixed minutes per case`, `${st.kept} cases marked saved, not unique customers`],
      cites: closed.map((r) => citeCase(a, merchantId, r)),
    });
  }
  if (has(q, /success rate/)) {
    return reply({ text: st.successRatePct === null ? "There are no payments in the last 7 days to work a success rate from." : `The seeded demo payment records show a ${st.successRatePct}% success rate over the last 7 days.`, bullets: ["Basis: captured payments divided by captured and failed payment records in the seeded demo; this is not a live account report."] });
  }
  if (has(q, /\b(dispute|chargeback)s?\b/)) {
    const d = st.disputesThisMonth;
    const open = casesOf("chargeback", ["needs_you", "handling"]);
    return reply({ text: `${d.total} dispute${d.total === 1 ? "" : "s"} this month: ${d.won} won, ${d.open} still open.`, bullets: ["Basis: seeded dispute records for this calendar month. Open cases are linked below; closed dispute rows are part of the demo data."], cites: open.map((r) => citeCase(a, merchantId, r)) });
  }
  // Receivables are not payables, and neither is a cash forecast. Do not let
  // shared words like "dues" or "owe" turn a liquidity question into AR.
  if (has(q, /\b(can i pay|pay all|vendor dues|supplier dues|cash ?flow|cash position|liquidity|afford)\b/)) {
    return reply({
      text: "I can't assess whether you can pay your dues yet. This demo has no connected bank balance, complete bills ledger, settlement/reconciliation feed, supplier payment rail or verified recipient.",
      bullets: ["The Dues screen is an illustrative arithmetic example, not a cash-flow forecast or payment workflow. I can show money owed to you in overdue invoices, but that is not the same as money you owe suppliers."],
      chips: ["Who owes me?", "Show overdue invoices"],
    });
  }
  if (has(q, /\b(who owes me|owed to me|customers owe|overdue|invoices?)\b/)) {
    const open = casesOf("collect", ["needs_you", "handling"]);
    return reply({
      text: `${rupees(st.overdue.amount)} is overdue across ${st.overdue.buyers} buyer${st.overdue.buyers === 1 ? "" : "s"} (${st.overdue.invoices} invoice${st.overdue.invoices === 1 ? "" : "s"}).`,
      bullets: ["Basis: seeded open B2B invoice cases, not supplier payables or a connected ledger."],
      cites: open.map((r) => citeCase(a, merchantId, r)),
    });
  }
  if (has(q, /\bsubscri/)) {
    const open = casesOf("subscription", ["needs_you", "handling"]);
    return reply({ text: `${st.subscriptionsAtRisk} subscription${st.subscriptionsAtRisk === 1 ? " is" : "s are"} at risk, and ${open.length} case${open.length === 1 ? " is" : "s are"} open.`, bullets: ["Basis: seeded subscription and case states in this demo."], cites: open.map((r) => citeCase(a, merchantId, r)) });
  }
  if (has(q, /\b(sales|revenue|sold|selling)\b/)) {
    return reply({ text: `The seeded demo records show ${rupees(st.todaysSales)} in captured sales today so far.`, bullets: ["Basis: captured payment rows since midnight in this demo, not a live sales report."] });
  }
  return null;
}

function rulesSummary(a: Adapters, merchantId: string): AskReply {
  const p = playbookView(a, merchantId);
  const rules = p.moments.flatMap((m) => m.rules.map((r) => ({ ...r, moment: m.label })));
  const on = rules.filter((r) => r.status === "approved");
  const proposed = rules.filter((r) => r.status === "proposed");
  return reply({
    text: `${on.length} rule${on.length === 1 ? " is" : "s are"} on${proposed.length ? `, and RAY suggests ${proposed.length} more` : ""}.`,
    bullets: ["Basis: saved playbook rules for this merchant in the demo." , ...on.map((r) => `On: ${r.text}`), ...proposed.map((r) => `Suggested: ${r.text}`)],
    cites: [{ label: "Rules", href: `/merchant/${merchantId}/rules` }],
    chips: proposed.slice(0, 1).map((r) => r.text),
  });
}

// "What can you do?" and "What should I set up first?" share one list.
function whatCanYouDo(a: Adapters, merchantId: string, first: boolean): AskReply {
  const caps = capabilities(a, merchantId);
  if (!first) {
    return reply({ kind: "capabilities", text: "Here's what this demo can do, with the most money waiting first.", bullets: ["Availability and open-case counts come from seeded demo records; Preview lanes are not live integrations."], capabilities: caps, chips: ["What should I set up first?", "What's waiting on me?"] });
  }
  const p = playbookView(a, merchantId);
  const suggested = p.moments.flatMap((m) => m.rules.filter((r) => r.status === "proposed"));
  const tryIt = caps.filter((c) => c.status === "Try it");
  const bullets = [
    ...suggested.map((r) => `Turn on "${r.text}". RAY suggested it from your own choices.`),
    ...caps.filter((c) => c.openCases > 0).slice(0, 2).map((c) => `${c.title}: ${c.openCases} open ${c.openCases === 1 ? "case" : "cases"}.`),
    ...tryIt.map((c) => `Try: ${c.title}.`),
  ].slice(0, 5);
  return reply({
    kind: "capabilities",
    text: "Start where your money is. In order:",
    bullets: [...bullets, "Basis: seeded demo case counts and saved rule choices; preview lanes are not live integrations."],
    capabilities: caps,
    cites: [{ label: "Rules", href: `/merchant/${merchantId}/rules` }],
    chips: suggested.slice(0, 1).map((r) => r.text),
  });
}

export function ask(a: Adapters, merchantId: string, text: string, caseId: string | null = null): AskReply {
  const raw = text.trim().slice(0, 400);
  if (!raw) return fallback();
  const q = norm(raw);

  // Rules first: what the merchant types is a request to RAY, never an order
  // to act. It only becomes a card they can approve.
  const plan = parseRuleRequest(raw);
  if (plan) {
    const card = describePlan(a, merchantId, plan);
    return reply({
      kind: "rule",
      text: card.alreadyOn ? "This rule is already on. Nothing to change." : "Here's the rule. It does nothing until you approve it.",
      rule: card,
      cites: [{ label: "Rules", href: `/merchant/${merchantId}/rules` }],
    });
  }

  if (has(q, /what (all )?can you do|what do you do|how can you help|^help$|what are you/)) return whatCanYouDo(a, merchantId, false);
  if (has(q, /(set up|setup|start|turn on).*first|where (do|should) i start|what should i (do|set)/)) return whatCanYouDo(a, merchantId, true);

  if (caseId) {
    if (has(q, /\b(told|said|message|reply|wrote|customer)\b/) && !has(q, /\bwhose\b/)) {
      const v = caseView(a, caseId);
      const sent = v.conversation.filter((c) => c.direction === "out").slice(-2);
      if (sent.length) {
        return reply({
          text: `${v.name} has been told:`,
          bullets: sent.map((c) => `${c.at} · ${c.channel}: ${c.body}`),
          cites: [{ label: `#${caseRef(a, caseId)} · ${v.name} · ${v.amount}`, href: `/merchant/${merchantId}/cases/${caseId}` }],
          chips: CASE_CHIPS.filter((c) => !c.includes("customer was told")),
        });
      }
      return reply({ text: `Nobody has written to ${v.name} yet. ${v.promiseLine ?? ""}`.trim(), cites: [{ label: `#${caseRef(a, caseId)}`, href: `/merchant/${merchantId}/cases/${caseId}` }] });
    }
    if (has(q, /\b(tap|approve|next|will happen|what does)\b/)) {
      const v = caseView(a, caseId);
      const p = v.yourCall.primary;
      return reply({
        text: p ? `If you tap "${p.label}", the guarded demo action runs. Follow-up and verification depend on the connected systems and case evidence.` : "There is no tap on this case right now.",
        bullets: [...(p ? [p.covered ? "Covered: if RAY gets this wrong, the error cover applies." : "Your call: this depends on your judgement."] : []), ...(p?.then ?? []).map((t) => `Then: ${t}`)],
        cites: [{ label: `#${caseRef(a, caseId)} · ${v.name} · ${v.amount}`, href: `/merchant/${merchantId}/cases/${caseId}` }],
      });
    }
    return aboutCase(a, merchantId, caseId);
  }

  if (has(q, /what.?s (waiting|pending|open)|waiting on me|needs? (me|my tap|you)|what needs/)) return whatsWaiting(a, merchantId);
  if (has(q, /refunds?\b.*\bproduct|by product/)) return refundsByProduct(a, merchantId);
  if (has(q, /\b(rules?|playbook)\b/)) return rulesSummary(a, merchantId);
  const byCustomer = customerAnswer(a, merchantId, q);
  if (byCustomer) return byCustomer;
  const n = numbers(a, merchantId, q);
  if (n) return n;
  return fallback();
}
