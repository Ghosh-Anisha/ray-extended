// Home (docs/ui-rebuild.md 3.1, first cut): what is waiting, what RAY did,
// and where each moment stands. Every number comes from merchantStats.
import { ArrowRight, CalendarDays, CheckCircle2, Clock, Sparkles, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { formatDate, formatTime } from "@/guards/format";
import { hoursLabel, rupees, type MerchantStats } from "@/surfaces/stats";
import { MOMENT_LABEL } from "@/surfaces/words";

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

export function Home({ merchantId, merchantName, stats }: { merchantId: string; merchantName: string; stats: MerchantStats }) {
  const base = `/merchant/${merchantId}`;
  const waiting = stats.needsYou.count > 0;
  return (
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
          <Link className="btn primary" href={`${base}/cases`}>
            Review cases
            <ArrowRight size={16} aria-hidden="true" />
          </Link>
        )}
      </section>

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
                {m.open} open{m.open === 1 ? "" : ""} · at stake
              </span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
