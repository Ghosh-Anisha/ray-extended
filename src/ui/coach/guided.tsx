"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { CoachPopover } from "./coach";

type DemoState = { cases?: Record<string, string> };
type GuidedStep = { title: string; text: string; target: string; next: string; href: (base: string, cases: Record<string, string>) => string };

const STEPS: GuidedStep[] = [
  { title: "Start with one case", text: "Demo amount marked saved: ₹1,84,300. This is a simulated total from demo cases, not money we've verified recovering. Choose Review cases to inspect the evidence and decide what needs your approval.", target: "[data-guided='review-cases']", next: "Review cases", href: (b) => `${b}/cases?guided=1&step=2` },
  { title: "Priya's case", text: "Before Priya contacted Leafy, Razorpay had recorded the payment and two webhook deliveries returned 200, while the store order stayed pending. Agentic Dashboard opened this case from that signal.", target: "[data-guided='case-priya']", next: "Open Priya's case", href: (b, c) => `${b}/cases/${c["RD-1042"] ?? ""}?guided=1&step=3` },
  { title: "Evidence and recommendation", text: "The dashboard compared the captured ₹1,299 payment, two webhook deliveries marked unprocessed, Leafy's pending order and a report from another store on the same plugin version. That report corroborates a plugin issue but does not prove the identical cause or confirm compensation. Review the evidence, then approve Mark paid & ship.", target: "[data-guided='primary-action']", next: "Approve Mark paid & ship", href: () => `/sim/inbox?guided=1&step=4&person=cus_priya` },
  { title: "Next morning reply", text: "Move the demo clock through the engine, then send Priya's reply through the inbound-message path. The demo checks that the case reaches Resolved with an arrived outcome; this is simulated, not a live customer confirmation.", target: "[data-guided-customer='priya']", next: "Skip to next morning", href: (b) => `${b}/whatsapp?guided=1&step=5` },
  { title: "RAY on WhatsApp", text: "Rahul was charged twice. Approve the duplicate refund. The case will show its real 10-minute Undo window.", target: "[data-guided='approve-rahul']", next: "Approve Rahul's duplicate refund", href: (b) => `${b}/rules?guided=1&step=6` },
  { title: "Make a repeated choice a rule", text: "Tap the example or type: Refund duplicate charges under ₹500 automatically. Then approve the rule.", target: "[data-coach='rules-chat']", next: "See chargebacks", href: (b, c) => `${b}/cases/${c["RD-1051"] ?? ""}?guided=1&step=7` },
  { title: "Chargebacks", text: "The dashboard shows delivery proof and the prepared response before Neha's deadline.", target: "[data-guided='primary-action']", next: "See subscriptions", href: (b, c) => `${b}/cases/${c["RD-1060"] ?? ""}?guided=1&step=8` },
  { title: "Save a subscription", text: "Karan wants to cancel. Choose a pause; the demo schedules the resume.", target: "[data-guided='primary-action']", next: "See the morning list", href: (b) => `${b}/collect?guided=1&step=9` },
  { title: "Invoice overdue", text: "Acme's promise is visible here. The simulated workflow matches a bank-credit example to the listed invoices before posting it.", target: "[data-guided='collect']", next: "Open My dashboard", href: (b) => `${b}/dashboard?guided=1&step=10` },
  { title: "My dashboard", text: "Answer three questions, add a widget in plain words, and keep the layout you want Agentic Dashboard to watch.", target: "[data-coach='dash-setup']", next: "Finish", href: (b) => b },
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
  const [completedStep, setCompletedStep] = useState<number | null>(null);
  const [busyStep, setBusyStep] = useState<number | null>(null);
  const [status, setStatus] = useState<{ step: number; text: string } | null>(null);
  const [morningRequestId, setMorningRequestId] = useState(() => crypto.randomUUID());
  const step = STEPS[stepNumber - 1]!;
  const refundParam = params.get("refund");
  const refundShown = stepNumber === 5 && refundParam === "1";
  const actionDone = completedStep === stepNumber;
  const busy = busyStep === stepNumber;
  const resultText = status?.step === stepNumber ? status.text : "";
  const activeTarget = refundShown ? "[data-guided='refund-hold']" : step.target;
  const base = useMemo(() => baseFor(path), [path]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent("ray:guided-mode", { detail: guided }));
  }, [guided]);

  useEffect(() => {
    const onAction = (event: Event) => {
      const detail = (event as CustomEvent<{ url: string; ok: boolean; error?: string; result?: unknown }>).detail;
      if (!guided || detail.url !== "/api/merchant/tap" || (stepNumber !== 3 && stepNumber !== 5)) return;
      if (!detail.ok) {
        setBusyStep(null);
        setStatus({ step: stepNumber, text: detail.error ?? "The action did not complete. Nothing was marked successful." });
        return;
      }
      const response = detail.result as { outcome?: string; caseId?: string | null; state?: string | null };
        if (response.outcome !== "handled" || !response.caseId || response.state !== "verifying") {
        setBusyStep(null);
        setStatus({ step: stepNumber, text: "The tap was recorded, but the case did not pass through to the intended action. The case remains in its actual engine state." });
        return;
      }
      if (stepNumber === 3) {
        setCompletedStep(stepNumber);
        setStatus({ step: stepNumber, text: "Merchant approval recorded. The guarded demo action ran, and the case is Checking it worked. The next step verifies the simulated store and customer outcome." });
      }
      else {
        setStatus({ step: stepNumber, text: "Refund approved. Opening the case to show its 10-minute Undo window." });
        router.push(`${base}/cases/${response.caseId}?guided=1&step=5&refund=1`);
      }
    };
    window.addEventListener("ray:merchant-action", onAction);
    return () => window.removeEventListener("ray:merchant-action", onAction);
  }, [guided, stepNumber, router, base]);

  useEffect(() => {
    if (!guided || !refundShown) return;
    const timer = window.setInterval(() => {
      if (document.querySelector("[data-guided='refund-hold']")) {
        setCompletedStep(5);
        setBusyStep(null);
        window.clearInterval(timer);
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, [guided, refundShown, activeTarget]);

  useEffect(() => {
    if (!guided) return;
    void fetch("/api/demo/state", { cache: "no-store" }).then((r) => r.json()).then((x: DemoState) => setState(x)).catch(() => undefined);
  }, [guided]);

  useEffect(() => {
    if (!guided || finished) return;
    let tries = 0;
    const timer = window.setInterval(() => {
      const el = document.querySelector<HTMLElement>(activeTarget);
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
  }, [guided, finished, step, activeTarget]);

  if (!guided) return null;
  const next = async () => {
    if ((stepNumber === 3 || stepNumber === 5) && !actionDone) {
      const target = document.querySelector<HTMLElement>(activeTarget);
      if (!target) { setStatus({ step: stepNumber, text: "The intended action is not available on this screen." }); return; }
      setBusyStep(stepNumber);
      target.click();
      return;
    }
    if (stepNumber === 4) {
      setBusyStep(stepNumber);
      try {
        const clockResponse = await fetch("/api/dev/clock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ms: 24 * 60 * 60 * 1000 }) });
        const clockJson = await clockResponse.json() as { ok: boolean; error?: string };
        if (!clockJson.ok) throw new Error(clockJson.error ?? "Clock did not advance");
        const response = await fetch("/api/dev/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ customerId: "cus_priya", channel: "whatsapp", body: "mil gaya, thanks", requestId: morningRequestId }) });
        const json = await response.json() as { ok: boolean; error?: string; result?: { outcome?: string; case?: { state?: string; outcome?: string; counts_as_saved?: boolean; amount?: number | null } } };
        const kase = json.result?.case;
        if (!json.ok || json.result?.outcome !== "handled" || kase?.state !== "closed" || kase.outcome !== "arrived" || !kase.counts_as_saved) {
          throw new Error(json.error ?? "Priya's reply did not resolve the case");
        }
        const saved = ((kase?.amount ?? 129900) / 100).toLocaleString("en-IN");
        setStatus({ step: stepNumber, text: `Simulated demo outcome verified: the store action completed and Priya replied “mil gaya, thanks”. Her case is Resolved and ₹${saved} is marked saved in demo data.` });
        setCompletedStep(stepNumber);
        setMorningRequestId(crypto.randomUUID());
        router.refresh();
      } catch (error) {
        setStatus({ step: stepNumber, text: error instanceof Error ? error.message : "The next-morning reply did not complete." });
      } finally { setBusyStep(null); }
      return;
    }
    if (stepNumber === STEPS.length) setFinished(true);
    else router.push(step.href(base, state.cases ?? {}));
  };
  if (finished) {
    return (
      <aside className="coach guided-end" role="dialog" aria-label="Guided demo complete">
        <strong>That&apos;s Agentic Dashboard, with RAY as the WhatsApp bot.</strong>
        <p className="coach-text">You saw the same engine move from evidence to a merchant tap, then keep following up.</p>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn secondary small" onClick={() => { setFinished(false); router.push(`${base}?guided=1&step=1`); }}>Restart</button>
          <button type="button" className="btn primary small" onClick={() => router.push(`${base}/whatsapp`)}>Open RAY on WhatsApp</button>
          <button type="button" className="btn tertiary small" onClick={() => router.push(base)}>Explore</button>
        </div>
      </aside>
    );
  }
  const shownText = resultText || (refundShown ? "Refund approved. The case and its 10-minute Undo window are shown here." : step.text);
  const nextLabel = busy ? "Doing it…" : actionDone ? "Continue" : step.next;
  return <CoachPopover anchor={anchor} title={`Step ${stepNumber} of 10 · ${step.title}`} text={shownText} step={stepNumber - 1} total={10} nextLabel={nextLabel} nextDisabled={busy || (refundShown && !actionDone)} onNext={() => void next()} onBack={stepNumber > 1 ? () => router.push(STEPS[stepNumber - 2]!.href(base, state.cases ?? {})) : undefined} onExit={() => router.push(base)} exitLabel="Exit" />;
}
