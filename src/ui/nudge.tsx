// The slim nudge bar at the bottom of the main column (docs/ui-rebuild.md
// section 5): one sentence, one action.
import { ArrowRight, Sparkles } from "lucide-react";
import Link from "next/link";

export function NudgeBar({ text, action }: { text: string; action: { label: string; href: string } }) {
  return (
    <aside className="nudge" aria-label="What to do next">
      <Sparkles size={16} aria-hidden="true" />
      <span className="grow">{text}</span>
      <Link className="btn primary small" href={action.href}>
        {action.label}
        <ArrowRight size={14} aria-hidden="true" />
      </Link>
    </aside>
  );
}
