"use client";

// "Try it" tours (docs/ui-rebuild.md sections 10 and 11): a link to a page
// with ?tour=name plays a short sequence of coach marks there, every time.
// It uses the same pop-up card as the first-visit marks (coach.tsx). Steps
// whose element is not on the page are skipped.
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { CoachPopover, type CoachStep } from "./coach";

const ROW = "table.data.mail tbody tr, .case-card";
const moment = (top: string, row: string): CoachStep[] => [
  { target: ".inbox-top", text: top },
  { target: ROW, text: row },
];

export const TOURS: Record<string, CoachStep[]> = {
  paid_no_order: moment("Customers who paid but whose order never showed up land here, biggest money first.", "Open one. RAY has already checked the payment, the webhook and the store."),
  international: moment("Cards declined abroad. RAY works out if it is the bank, the limit or your settings.", "Open one to see the fix RAY proposes, such as a payment link for the customer."),
  subscription: moment("Subscribers who are about to stop. RAY offers a pause, a discount or a retry.", "Open one to pick the offer. RAY can turn a repeated choice into a rule."),
  chargeback: moment("Disputes with their reply deadline. RAY gathers the proof for you.", "Open one to see the evidence RAY found and approve the reply."),
  collect: moment("Overdue invoices. RAY reminds the buyer, notes each promise and matches the bank credit.", "Open one to see what was promised and what RAY sent."),
  grow: [
    { target: "[data-coach='grow-card']", text: "RAY found this in your own orders: big carts that never got paid." },
    { target: "[data-coach='grow-actions']", text: "Preview the modeled scenario, or choose Not now. Two weeks later the demo shows a simulated before and after, not measured growth." },
  ],
  dashboard: [
    { target: "[data-coach='dash-setup']", text: "Three quick questions. They are already picked from your data, so you can just build." },
    { target: "[data-coach='dash-widgets']", text: "Each number comes from your payments and cases, with its definition underneath." },
    { target: "[data-coach='dash-ask']", text: "Ask for a widget in plain words, like “show refunds by product”." },
    { target: "[data-coach='dash-watch']", text: "RAY watches pinned numbers against your normal. When one moves, you get a badge and a Why?." },
    { target: "[data-coach='dash-reports']", text: "Reports use captured-payment data and estimated fees. You can save a demo schedule, but no CA recipient is connected, so nothing is sent." },
  ],
};

type Rect = { top: number; left: number; width: number; height: number };

function Tour({ name }: { name: string }) {
  const [steps, setSteps] = useState<CoachStep[] | null>(null);
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [closed, setClosed] = useState(false);

  // Wait for the page to draw, then keep the steps whose element exists.
  useEffect(() => {
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      const all = TOURS[name];
      const found = all.filter((s) => s.target && document.querySelector(s.target));
      if (found.length > 0 && (found.length === all.length || tries >= 6)) {
        window.clearInterval(timer);
        setSteps(found);
      } else if (tries >= 12) window.clearInterval(timer);
    }, 250);
    return () => window.clearInterval(timer);
  }, [name]);

  const step = steps?.[i];
  useEffect(() => {
    if (!step || closed || !step.target) return;
    const el = document.querySelector<HTMLElement>(step.target);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    const measure = () => {
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [step, closed]);

  if (!steps || !step || !rect || closed) return null;
  const last = i === steps.length - 1;
  return <CoachPopover anchor={rect} text={step.text} step={i} total={steps.length} nextLabel={last ? "Got it" : "Next"} onNext={() => (last ? setClosed(true) : setI(i + 1))} onBack={() => setI(Math.max(0, i - 1))} onExit={() => setClosed(true)} />;
}

export function TourHost() {
  const params = useSearchParams();
  if (params.get("guided") === "1") return null;
  const name = params.get("tour");
  if (!name || !TOURS[name]) return null;
  return <Tour key={name} name={name} />;
}
