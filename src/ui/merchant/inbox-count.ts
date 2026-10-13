import type { Moment } from "@/db/schema";
import type { InboxTab } from "@/surfaces/words";

export function inboxCountForTab(rows: { momentKey: Moment }[], moment: Moment | null): number {
  return moment ? rows.filter((row) => row.momentKey === moment).length : rows.length;
}

export function inboxRowsForTab<T extends { momentKey: Moment }>(tabs: { key: string; rows: T[] }[], tab: InboxTab): T[] {
  const rows = tab === "all" ? tabs.flatMap((item) => item.rows) : tabs.find((item) => item.key === tab)?.rows ?? [];
  return rows;
}
