"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { CoachPopover } from "./coach";

type DemoState = { cases?: Record<string, string> };
type GuidedStep = { title: string; text: string; target: string; next: string; href: (base: string, cases: Record<string, string>) => string };

const STEPS: GuidedStep[] = [
  { title: "This is Leafy Bakes", text: "RAY saved ₹1,84,300 this month. ₹8,450 is waiting on you.", target: "[data-guided='review-cases']", next: "Review cases", href: (b) => `${b}/cases?guided=1&step=2` },
  { title: "Biggest first", text: "Priya paid ₹1,299 but her order never showed up.", target: "[data-guided='case-priya']", next: "Open Priya's case", href: (b, c) => `${b}/cases/${c["RD-1042"] ?? ""}?guided=1&step=3` },
  { title: "RAY found the cause", text: "The plugin accepted the payment and dropped the order update. It is on Razorpay, so it is free.", target: "[data-guided='primary-action']", next: "See what Priya received", href: () => `/sim/inbox?guided=1&step=4` },
  { title: "Here's what Priya received", text: "Skip to next morning and watch the reply close the loop.", target: "[data-tour='thread-list']", next: "Skip to next morning", href: (b) => `${b}/whatsapp?guided=1&step=5` },
  { title: "RAY on WhatsApp", text: "Most merchants live here. Rahul was charged twice, and the approval card is ready.", target: "[data-testid='approval-card']", next: "Open Ask RAY", href: (b) => `${b}/rules?guided=1&step=6` },
  { title: "Make a repeated choice a rule", text: "Tap the example or type: Refund duplicate charges under ₹500 automatically. Then approve the rule.", target: "[data-coach='rules-chat']", next: "See chargebacks", href: (b, c) => `${b}/cases/${c["RD-1051"] ?? ""}?guided=1&step=7` },
  { title: "Chargebacks", text: "RAY found delivery proof and prepared the reply before Neha's deadline.", target: "[data-guided='primary-action']", next: "See subscriptions", href: (b, c) => `${b}/cases/${c["RD-1060"] ?? ""}?guided=1&step=8` },
  { title: "Save a subscription", text: "Karan wants to cancel. Choose a pause, then RAY schedules the resume.", target: "[data-guided='primary-action']", next: "See the morning list", href: (b) => `${b}/collect?guided=1&step=9` },
  { title: "Invoice overdue", text: "Acme's promise is visible here. RAY matches a bank credit to the right invoices before posting it.", target: "[data-guided='collect']", next: "Open My dashboard", href: (b) => `${b}/dashboard?guided=1&step=10` },
  { title: "My dashboard", text: "Answer three questions, add a widget in plain words, and keep the layout you want RAY to watch.", target: "[data-coach='dash-setup']", next: "Finish", href: (b) => b },
];

function baseFor(path: string) {
  const m = path.match(/^\/merchant\/([^/]+)/);
  return m ? `/merchant/${m[1]}` : "/merchant/m_leafy_bakes";
}

export function GuidedDemoHost() {
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const guided = params.get("guided") === "1";
  const rawStep = Number(params.get("step") ?? "1");
  const stepNumber = Number.isFinite(rawStep) && rawStep >= 1 && rawStep <= STEPS.length ? rawStep : 1;
  const [state, setState] = useState<DemoState>({});
  const [anchor, setAnchor] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const [finished, setFinished] = useState(false);
  const step = STEPS[stepNumber - 1]!;
  const base = useMemo(() => baseFor(path), [path]);

  useEffect(() => {
    if (!guided) return;
    void fetch("/api/demo/state", { cache: "no-store" }).then((r) => r.json()).then((x: DemoState) => setState(x)).catch(() => undefined);
  }, [guided]);

  useEffect(() => {
    if (!guided || finished) return;
    let tries = 0;
    const timer = window.setInterval(() => {
      const el = document.querySelector<HTMLElement>(step.target);
      tries += 1;
      if (el) {
        window.clearInterval(timer);
        el.scrollIntoView({ block: "center", inline: "nearest" });
        const measure = () => {
          const r = el.getBoundingClientRect();
          setAnchor({ top: r.top, left: r.left, width: r.width, height: r.height });
        };
        measure();
        window.addEventListener("resize", measure);
        window.addEventListener("scroll", measure, true);
      } else if (tries > 20) window.clearInterval(timer);
    }, 100);
    return () => window.clearInterval(timer);
  }, [guided, finished, step]);

  if (!guided) return null;
  const next = async () => {
    if (stepNumber === 4) {
      await fetch("/api/dev/clock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ms: 24 * 60 * 60 * 1000 }) });
    }
    if (stepNumber === STEPS.length) setFinished(true);
    else router.push(step.href(base, state.cases ?? {}));
  };
  if (finished) {
    return (
      <aside className="coach guided-end" role="dialog" aria-label="Guided demo complete">
        <strong>That&apos;s RAY: an account manager that acts, for every small merchant.</strong>
        <p className="coach-text">You saw the same engine move from evidence to a merchant tap, then keep following up.</p>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn secondary small" onClick={() => { setFinished(false); router.push(`${base}?guided=1&step=1`); }}>Restart</button>
          <button type="button" className="btn primary small" onClick={() => router.push(`${base}?tour=grow`)}>See what RAY can do</button>
          <button type="button" className="btn tertiary small" onClick={() => router.push(base)}>Explore</button>
        </div>
      </aside>
    );
  }
  return <CoachPopover anchor={anchor} title={`Step ${stepNumber} of 10 · ${step.title}`} text={step.text} step={stepNumber - 1} total={10} nextLabel={step.next} onNext={() => void next()} onBack={stepNumber > 1 ? () => window.history.back() : undefined} onExit={() => router.push(base)} exitLabel="Exit" />;
}
