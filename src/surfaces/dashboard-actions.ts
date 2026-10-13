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
  setupWidgets,
  starterWidgets,
  unsupportedSetupRequests,
  WIDGET_DEFINITION,
  WIDGET_TITLE,
  writeState,
  type Report,
  type SavedWidget,
  type SavedReportPreview,
  type Setup,
} from "./dashboard";

const input = z.discriminatedUnion("action", [
  z.object({ action: z.literal("setup"), merchantId: z.string(), business: z.string(), daily: z.array(z.string()), audience: z.string(), request: z.string().max(200).optional() }),
  z.object({ action: z.literal("ask"), merchantId: z.string(), text: z.string().min(1).max(200) }),
  z.object({ action: z.literal("remove"), merchantId: z.string(), id: z.string() }),
  z.object({ action: z.literal("watch"), merchantId: z.string(), id: z.string(), watch: z.boolean() }),
  z.object({ action: z.literal("keep"), merchantId: z.string() }),
  z.object({ action: z.literal("pin"), merchantId: z.string(), kind: z.string() }),
  z.object({ action: z.literal("not_now"), merchantId: z.string() }),
  z.object({ action: z.literal("report"), merchantId: z.string(), text: z.string().min(1).max(200) }),
  z.object({ action: z.literal("save_preview"), merchantId: z.string(), what: z.enum(["report", "pack"]), text: z.string().optional() }),
  z.object({ action: z.literal("redo"), merchantId: z.string() }),
]);

export type DashboardInput = z.infer<typeof input>;
export type DashboardResult = { message?: string; chips?: string[]; report?: Report; savedPreview?: SavedReportPreview; widgets?: string[] };

const widgetsOf = (a: Adapters, merchantId: string): SavedWidget[] => {
  const setup = readState<Setup>(a, merchantId, "dash.setup");
  return readState<SavedWidget[]>(a, merchantId, "dash.widgets") ?? (setup ? starterWidgets(setup) : []);
};

export function dashboardAction(a: Adapters, raw: unknown): DashboardResult {
  const i = input.parse(raw);
  const m = i.merchantId;
  switch (i.action) {
    case "setup": {
      const setup: Setup = { business: i.business, daily: i.daily, audience: i.audience, ...(i.request?.trim() ? { request: i.request.trim() } : {}) };
      const widgets = setupWidgets(setup);
      writeState(a, m, "dash.setup", setup);
      writeState(a, m, "dash.widgets", widgets);
      writeState(a, m, "dash.kept", true);
      const savedSetup = readState<Setup>(a, m, "dash.setup");
      const savedWidgets = readState<SavedWidget[]>(a, m, "dash.widgets");
      if (!savedSetup || !savedWidgets || savedWidgets.length !== widgets.length || savedWidgets.some((w, at) => w.id !== widgets[at]?.id || w.watch !== widgets[at]?.watch)) {
        throw new Error("Dashboard setup could not be confirmed in saved data. Try again.");
      }
      const unsupported = unsupportedSetupRequests(setup);
      return {
        message: `Dashboard saved with ${savedWidgets.length} supported metrics. It is available on My dashboard and Home.`,
        widgets: savedWidgets.map((w) => w.kind),
        ...(unsupported.length ? { chips: ["Show refunds by product", "Show success rate by bank", "Add overdue invoices"] } : {}),
      };
    }
    case "redo":
      writeState(a, m, "dash.setup", null);
      writeState(a, m, "dash.widgets", []);
      writeState(a, m, "dash.kept", false);
      return {};
    case "ask": {
      const kind = parseWidgetAsk(i.text);
      if (!kind) return { message: `I can't build “${i.text}” without changing its meaning. I can add only a supported demo widget:`, chips: ["Show refunds by product", "Show success rate by bank", "Add overdue invoices"] };
      recordAsk(a, m, kind);
      const widgets = widgetsOf(a, m);
      if (widgets.some((w) => w.kind === kind)) return { message: `${WIDGET_TITLE[kind]} is already on your dashboard.` };
      writeState(a, m, "dash.widgets", [...widgets, { id: `w_${kind}`, kind, source: "asked", watch: false }]);
      writeState(a, m, "dash.kept", true);
      return { message: `Added ${WIDGET_TITLE[kind]}. ${WIDGET_DEFINITION[kind]}` };
    }
    case "remove": {
      writeState(a, m, "dash.widgets", widgetsOf(a, m).filter((w) => w.id !== i.id));
      writeState(a, m, "dash.kept", true);
      return {};
    }
    case "watch": {
      const widgets = widgetsOf(a, m);
      if (!widgets.some((w) => w.id === i.id)) throw new Error("That metric is no longer on your dashboard. Refresh and try again.");
      writeState(a, m, "dash.widgets", widgets.map((w) => w.id === i.id ? { ...w, watch: i.watch } : w));
      writeState(a, m, "dash.kept", true);
      const saved = readState<SavedWidget[]>(a, m, "dash.widgets")?.find((w) => w.id === i.id);
      if (!saved || saved.watch !== i.watch) throw new Error("The watch change could not be confirmed in saved data. Try again.");
      return { message: i.watch ? "Metric saved to your watched list." : "Metric removed from your watched list." };
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
      writeState(a, m, "dash.kept", true);
      return { message: "Pinned. RAY will watch it and tell you when it moves." };
    }
    case "not_now":
      writeState(a, m, "dash.suggestion_dismissed", { day: Math.floor((a.clock.now() + 19_800_000) / 86_400_000) * 86_400_000 - 19_800_000 });
      return {};
    case "report": {
      const report = buildReport(a, m, i.text);
      if (!report) return { message: `I can't build “${i.text}” without changing its period or measure. I can build these demo reports:`, chips: ["Estimated net collections for September with fees and GST", "Refunds for September", "Disputes this month"] };
      return { report };
    }
    case "save_preview": {
      const report = i.what === "pack" ? null : buildReport(a, m, i.text ?? "");
      const title = i.what === "pack" ? `Month-end CA pack, ${caPack(a, m).month}` : report?.title;
      if (!title) throw new Error("Pick a report first");
      const reportId = report?.id ?? "pack";
      const savedAt = a.clock.now();
      const savedPreview: SavedReportPreview = { id: `preview_${reportId}_${savedAt}`, reportId, title, savedAt, status: "preview_only" };
      const list = readState<SavedReportPreview[]>(a, m, "dash.report_previews") ?? [];
      writeState(a, m, "dash.report_previews", [...list.filter((x) => x.reportId !== savedPreview.reportId), savedPreview]);
      return { savedPreview, message: `Simulated preview saved for ${title}. No recipient, recurring schedule or delivery is configured.` };
    }
  }
}
