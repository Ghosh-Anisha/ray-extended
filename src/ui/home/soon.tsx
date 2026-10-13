import Link from "next/link";

// A screen that arrives in a later build: what will appear, and one action.
export function Soon({ title, line, action }: { title: string; line: string; action: { label: string; href: string } }) {
  return (
    <div className="stack">
      <h1 className="page-title">{title}</h1>
      <div className="empty stack" style={{ alignItems: "center" }}>
        <span>{line}</span>
        <Link className="btn primary" href={action.href}>
          {action.label}
        </Link>
      </div>
    </div>
  );
}
