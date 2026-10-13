import Link from "next/link";

export type Crumb = { label: string; href?: string };

// "Agentic Dashboard › Cases › #RD-1042". The last crumb is the page itself.
export function Breadcrumbs({ trail }: { trail: Crumb[] }) {
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {trail.map((c, i) => {
        const last = i === trail.length - 1;
        return (
          <span key={`${c.label}-${i}`} className="row" style={{ gap: 6 }}>
            {c.href && !last ? <Link href={c.href}>{c.label}</Link> : <span aria-current={last ? "page" : undefined}>{c.label}</span>}
            {!last && <span aria-hidden="true">›</span>}
          </span>
        );
      })}
    </nav>
  );
}
