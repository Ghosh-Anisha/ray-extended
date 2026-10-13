import type { Moment } from "@/db/schema";

export function inboxCountForTab(rows: { momentKey: Moment }[], moment: Moment | null): number {
  return moment ? rows.filter((row) => row.momentKey === moment).length : rows.length;
}
