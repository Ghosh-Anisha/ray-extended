// Home (docs/ui-rebuild.md 3.1, first cut): what is waiting, what RAY did,
// and where each moment stands. Every number comes from merchantStats.
import { ArrowRight, CalendarDays, CheckCircle2, Clock, LayoutDashboard, ListChecks, Sparkles, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { formatDate, formatTime } from "@/guards/format";
import { hoursLabel, rupees, type MerchantStats } from "@/surfaces/stats";
import type { ApprovalCard as Card } from "@/surfaces/views";
import { MOMENT_LABEL } from "@/surfaces/words";
import { ApprovalCard } from "../merchant/approval-card";
import { NudgeBar } from "../nudge";
import type { EmiCard } from "@/surfaces/grow";
import { CoachMarks } from "../coach/coach";
import { Capabilities } from "./capabilities";
import { GuidedDemoCard } from "./guided-card";
import { ProactiveCards } from "./proactive";

const TOP_MOMENT_LINE: Record<string, string> = {
  paid_no_order: "Most saves came from orders your store missed after payment.",
  international: "Most saves came from customers abroad whose cards RAY got through.",
  subscription: "Most saves came from subscriptions RAY kept running.",
  chargeback: "Most saves came from chargebacks RAY helped you win.",
  collect: "Most saves came from overdue invoices RAY chased until they were paid.",
};

function DateChips({ stats }: { stats: MerchantStats }) {
  return (
    <>
      <span className="date-chip">
        <CalendarDays size={14} aria-hidden="true" />
        {formatDate(stats.window.from)} – {formatDate(stats.window.to)}
      </span>
      <span className="date-chip">
        <Clock size={14} aria-hidden="true" />
        Updated {formatTime(stats.now)}
      </span>
    </>
  );
}

function Insight({ children }: { children: string }) {
  return (
    <span className="insight">
      <Sparkles size={12} aria-hidden="true" />
      <span>
        <strong>Insight by RAY</strong> · {children}
      </span>
    </span>
  );
}

export type TopCase = { id: string; name: string; amount: string };

export type HomeExtras = { emi: EmiCard | null; chase: { line: string; href: string } | null; rayOn: boolean; dashboardSet: boolean };

export function Home({ merchantId, merchantName, stats, card, topCase, extras }: { merchantId: string; merchantName: string; stats: MerchantStats; card: Card | null; topCase: TopCase | null; extras: HomeExtras }) {
  const base = `/merchant/${merchantId}`;
  const waiting = stats.needsYou.count > 0;
  return (
    <div className="stack">
      <div className="home-grid">
      <div className="stack">
      <div>
        <h1 className="page-title">{merchantName}</h1>
        <p className="page-sub">What RAY is doing for you.</p>
      </div>

      <section className={`panel attention ${waiting ? "" : "clear"}`} aria-label="Waiting on you">
        <span className="icon">{waiting ? <TriangleAlert size={20} aria-hidden="true" /> : <CheckCircle2 size={20} aria-hidden="true" />}</span>
        <div className="grow">
          {waiting ? (
            <>
              <strong>{rupees(stats.needsYou.stake)} waiting on you.</strong>{" "}
              <span>
                {stats.needsYou.count} {stats.needsYou.count === 1 ? "case needs" : "cases need"} a tap.
              </span>
            </>
          ) : (
            <strong>You&apos;re all caught up.</strong>
          )}
        </div>
        {waiting && (
          <Link className="btn primary" data-guided="review-cases" href={`${base}/cases`}>
            Review cases
            <ArrowRight size={16} aria-hidden="true" />
          </Link>
        )}
      </section>

      <GuidedDemoCard merchantId={merchantId} />

      <section className="stack" style={{ gap: 12 }} aria-label="What RAY did">
        <div className="section-head">
          <h2>What RAY did this month</h2>
          <DateChips stats={stats} />
        </div>
        <div className="grid-4">
          <div className="panel stack" style={{ gap: 8 }}>
            <span className="metric-label">₹ saved</span>
            <span className="big-number">{rupees(stats.saved.amount)}</span>
            {stats.saved.changePct !== null && stats.saved.changePct > 0 && <span className="trend" style={{ alignSelf: "flex-start" }}>↑ {stats.saved.changePct}% vs last month</span>}
            {stats.saved.topMoment && <Insight>{TOP_MOMENT_LINE[stats.saved.topMoment]}</Insight>}
          </div>
          <div className="panel stack" style={{ gap: 8 }}>
            <span className="metric-label">Time saved</span>
            <span className="big-number">{hoursLabel(stats.timeSavedMinutes)}</span>
            <span className="muted">Work you did not have to do</span>
            <Insight>{`${stats.closed.byRay} of ${stats.closed.count} cases closed without you taking over.`}</Insight>
          </div>
          <div className="panel stack" style={{ gap: 8 }}>
            <span className="metric-label">Cases closed</span>
            <span className="big-number">{stats.closed.count}</span>
            <span className="muted">In the last 30 days</span>
            <Insight>Each one has a timeline you can open.</Insight>
          </div>
          <div className="panel stack" style={{ gap: 8 }}>
            <span className="metric-label">Customers kept</span>
            <span className="big-number">{stats.kept}</span>
            <span className="muted">Money or order sorted out</span>
            <Insight>They were told what happened in words they could check.</Insight>
          </div>
        </div>
      </section>

      <ProactiveCards merchantId={merchantId} emi={extras.emi} chase={extras.chase} />

      <section className="stack" style={{ gap: 12 }} aria-label="By moment">
        <div className="section-head">
          <h2>By moment</h2>
        </div>
        <div className="grid-5">
          {stats.byMoment.map((m) => (
            <Link key={m.moment} className="panel moment-card" href={`${base}/cases?moment=${m.moment}`}>
              <span className="name">{MOMENT_LABEL[m.moment]}</span>
              <span className="stake">{rupees(m.stake)}</span>
              <span className="muted">
                {m.open} open · at stake
              </span>
            </Link>
          ))}
        </div>
      </section>

      <Capabilities merchantId={merchantId} rayOn={extras.rayOn} dashboardSet={extras.dashboardSet} />

      <section className="stack" style={{ gap: 12 }} aria-label="Recommended for you">
        <div className="section-head">
          <h2>Recommended for you</h2>
        </div>
        <div className="grid-3">
          <Link className="panel tile" href={`${base}/dashboard`}>
            <span className="tile-icon"><LayoutDashboard size={18} aria-hidden="true" /></span>
            <strong>Set up My dashboard</strong>
            <span className="muted">Answer three questions and get the numbers you check every day.</span>
          </Link>
          <Link className="panel tile" href={`${base}/ask`}>
            <span className="tile-icon"><Sparkles size={18} aria-hidden="true" /></span>
            <strong>Ask RAY</strong>
            <span className="muted">Ask why an order did not show up, or what is waiting on you.</span>
          </Link>
          <Link className="panel tile" href={`${base}/rules`}>
            <span className="tile-icon"><ListChecks size={18} aria-hidden="true" /></span>
            <strong>Set a rule</strong>
            <span className="muted">Tell RAY once, for example to refund small duplicate charges.</span>
          </Link>
        </div>
      </section>
      </div>

      <aside className="stack home-rail" aria-label="RAY on WhatsApp">
        <div className="section-head">
          <h2>RAY on WhatsApp</h2>
          <span className="chip simulated">Simulated</span>
        </div>
        <div className="phone-frame">
          <div className="wa-head">
            <span>RAY</span>
            <span>Leafy Bakes</span>
          </div>
          <div className="wa" style={{ borderRadius: 0, minHeight: 260 }}>
            {card ? <ApprovalCard card={card} merchantId={merchantId} /> : <div className="bubble">Nothing is waiting on you. RAY will message you here when it is.</div>}
          </div>
        </div>
        <Link className="btn secondary" href={`${base}/whatsapp`}>
          Open on WhatsApp
        </Link>
      </aside>
      </div>

      <CoachMarks
        id="home-u6"
        steps={[
          { target: "[data-coach='capabilities']", text: "Everything RAY can do for you. Each card says if it is On, ready to Try, or Coming soon." },
          { target: "[data-coach='suggestions']", text: "RAY also suggests changes from your own numbers. You decide: Turn on or Not now." },
          { target: "[data-coach='try-it']", text: "Try it opens a short example on Leafy Bakes, with RAY pointing things out." },
        ]}
      />
      <NudgeBar
        text={topCase ? `${stats.needsYou.count} ${stats.needsYou.count === 1 ? "case needs" : "cases need"} you. Start with the biggest: ${topCase.name}, ${topCase.amount}.` : "You're all caught up. Ask RAY what it can do for you next."}
        action={topCase ? { label: "Open", href: `${base}/cases/${topCase.id}` } : { label: "Ask RAY", href: `${base}/ask` }}
      />
    </div>
  );
}
