// What the merchant can do on My dashboard. Each action saves a choice in
// ui_state; none of them touches a case or moves money.
import { z } from "zod";
import type { Adapters } from "@/adapters";
import {
  buildReport,
  caPack,
  parseWidgetAsk,
  readState,
  recordAsk,
  starterWidgets,
  WIDGET_DEFINITION,
  WIDGET_TITLE,
  writeState,
  type Report,
  type SavedWidget,
  type Schedule,
  type Setup,
} from "./dashboard";

const input = z.discriminatedUnion("action", [
  z.object({ action: z.literal("setup"), merchantId: z.string(), business: z.string(), daily: z.array(z.string()), audience: z.string() }),
  z.object({ action: z.literal("ask"), merchantId: z.string(), text: z.string().min(1).max(200) }),
  z.object({ action: z.literal("remove"), merchantId: z.string(), id: z.string() }),
  z.object({ action: z.literal("keep"), merchantId: z.string() }),
  z.object({ action: z.literal("pin"), merchantId: z.string(), kind: z.string() }),
  z.object({ action: z.literal("not_now"), merchantId: z.string() }),
  z.object({ action: z.literal("report"), merchantId: z.string(), text: z.string().min(1).max(200) }),
  z.object({ action: z.literal("schedule"), merchantId: z.string(), what: z.enum(["report", "pack"]), text: z.string().optional() }),
  z.object({ action: z.literal("redo"), merchantId: z.string() }),
]);

export type DashboardInput = z.infer<typeof input>;
export type DashboardResult = { message?: string; chips?: string[]; report?: Report; scheduled?: Schedule };

const widgetsOf = (a: Adapters, merchantId: string): SavedWidget[] => {
  const setup = readState<Setup>(a, merchantId, "dash.setup");
  return readState<SavedWidget[]>(a, merchantId, "dash.widgets") ?? (setup ? starterWidgets(setup) : []);
};

export function dashboardAction(a: Adapters, raw: unknown): DashboardResult {
  const i = input.parse(raw);
  const m = i.merchantId;
  switch (i.action) {
    case "setup": {
      const setup: Setup = { business: i.business, daily: i.daily, audience: i.audience };
      writeState(a, m, "dash.setup", setup);
      writeState(a, m, "dash.widgets", starterWidgets(setup));
      writeState(a, m, "dash.kept", false);
      return {};
    }
    case "redo":
      writeState(a, m, "dash.setup", null);
      writeState(a, m, "dash.widgets", []);
      writeState(a, m, "dash.kept", false);
      return {};
    case "ask": {
      const kind = parseWidgetAsk(i.text);
      if (!kind) return { message: "I can't build that yet. Here's what I can add:", chips: ["Show refunds by product", "Show success rate by bank", "Add overdue invoices"] };
      recordAsk(a, m, kind);
      const widgets = widgetsOf(a, m);
      if (widgets.some((w) => w.kind === kind)) return { message: `${WIDGET_TITLE[kind]} is already on your dashboard.` };
      writeState(a, m, "dash.widgets", [...widgets, { id: `w_${kind}`, kind, source: "asked", watch: false }]);
      writeState(a, m, "dash.kept", false);
      return { message: `Added ${WIDGET_TITLE[kind]}. ${WIDGET_DEFINITION[kind]}` };
    }
    case "remove": {
      writeState(a, m, "dash.widgets", widgetsOf(a, m).filter((w) => w.id !== i.id));
      writeState(a, m, "dash.kept", false);
      return {};
    }
    case "keep":
      writeState(a, m, "dash.kept", true);
      return { message: "Saved. This is your dashboard now." };
    case "pin": {
      const widgets = widgetsOf(a, m);
      const has = widgets.find((w) => w.kind === i.kind);
      const next = has
        ? widgets.map((w) => (w.kind === i.kind ? { ...w, watch: true } : w))
        : [...widgets, { id: `w_${i.kind}`, kind: i.kind as SavedWidget["kind"], source: "suggested" as const, watch: true }];
      writeState(a, m, "dash.widgets", next);
      return { message: "Pinned. RAY will watch it and tell you when it moves." };
    }
    case "not_now":
      writeState(a, m, "dash.suggestion_dismissed", { day: Math.floor((a.clock.now() + 19_800_000) / 86_400_000) * 86_400_000 - 19_800_000 });
      return {};
    case "report": {
      const report = buildReport(a, m, i.text);
      if (!report) return { message: "I can't build that report yet. Here's what I can do:", chips: ["Settlements for September with fees and GST", "Refunds for September", "Disputes this month"] };
      return { report };
    }
    case "schedule": {
      const report = i.what === "pack" ? null : buildReport(a, m, i.text ?? "");
      const title = i.what === "pack" ? `Month-end CA pack, ${caPack(a, m).month}` : report?.title;
      if (!title) throw new Error("Pick a report first");
      const schedule: Schedule = { id: `sch_${a.clock.now()}`, reportId: report?.id ?? "pack", title, to: "your CA on WhatsApp", when: "On the 1st of every month, 9:00 AM", at: a.clock.now() };
      const list = readState<Schedule[]>(a, m, "dash.schedules") ?? [];
      writeState(a, m, "dash.schedules", [...list.filter((x) => x.reportId !== schedule.reportId), schedule]);
      return { scheduled: schedule, message: `Scheduled. ${title} will go to your CA on WhatsApp (Simulated).` };
    }
  }
}
