// Playbook settings per moment: tone, sign-off and send-from, plus the
// automatic customer messages switch the approval guard already reads.
// They are stored as playbook_rules rows with rule_json.setting, the same
// way auto_customer_messages is, so guards and the write job read them from
// the database. Every setting row names tool "none" (or the one tool it
// covers), so it can never stand in for a rule that approves an action.
import { and, eq } from "drizzle-orm";
import { newId } from "@/adapters/ids";
import type { Db } from "@/db/client";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import type { Moment } from "@/db/schema";
import { AUTO_CUSTOMER_MESSAGES } from "@/guards";
import type { RefundSpeedSetting, ToneSetting } from "./words";

export { TONES, type ToneSetting } from "./words";
export type SendFrom = (typeof s.SENDER_MODES)[number];

export type MomentSettings = { tone: ToneSetting; signOff: string; sendFrom: SendFrom; autoMessages: boolean; refundSpeed: RefundSpeedSetting };

export const SETTING_KEYS = ["tone", "sign_off", "send_from", AUTO_CUSTOMER_MESSAGES, "refund_speed"] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export const isSettingRow = (r: { rule_json: Record<string, unknown> }) => typeof r.rule_json.setting === "string";

export function defaultSettings(merchantName: string): MomentSettings {
  return { tone: "Warm", signOff: `Team ${merchantName}`, sendFrom: "merchant_inbox", autoMessages: false, refundSpeed: "normal" };
}

function settingRow(db: Db, merchantId: string, moment: Moment, key: SettingKey) {
  return createRepository(db)
    .playbookRules.list(and(eq(s.playbookRules.merchant_id, merchantId), eq(s.playbookRules.moment, moment)))
    .find((r) => r.rule_json.setting === key);
}

export function readSettings(db: Db, merchantId: string, moment: Moment): MomentSettings {
  const repo = createRepository(db);
  const merchant = repo.merchants.get(merchantId);
  if (!merchant) throw new Error(`Merchant ${merchantId} not found`);
  const d = defaultSettings(merchant.name);
  const val = (key: SettingKey) => settingRow(db, merchantId, moment, key)?.rule_json;
  const auto = val(AUTO_CUSTOMER_MESSAGES);
  const autoRow = settingRow(db, merchantId, moment, AUTO_CUSTOMER_MESSAGES);
  return {
    tone: (val("tone")?.value as ToneSetting | undefined) ?? d.tone,
    signOff: (val("sign_off")?.value as string | undefined) ?? d.signOff,
    sendFrom: (val("send_from")?.value as SendFrom | undefined) ?? d.sendFrom,
    autoMessages: autoRow?.status === "approved" && auto?.on === true,
    refundSpeed: (val("refund_speed")?.value as RefundSpeedSetting | undefined) ?? d.refundSpeed,
  };
}

const SETTING_TEXT: Record<SettingKey, string> = {
  tone: "Tone of customer messages",
  sign_off: "Sign-off on customer messages",
  send_from: "Send customer messages from",
  [AUTO_CUSTOMER_MESSAGES]: "Send automatic customer messages",
  refund_speed: "Refund speed",
};

// The merchant changed a setting: write it (an update keeps one row per
// setting and moment).
export function writeSetting(db: Db, now: number, merchantId: string, moment: Moment, key: SettingKey, value: string | boolean) {
  const repo = createRepository(db);
  const rule_json =
    key === AUTO_CUSTOMER_MESSAGES
      ? { setting: key, on: value === true, tool: "send_message", kind: "auto_customer" }
      : { setting: key, value: String(value), tool: "none" };
  const existing = settingRow(db, merchantId, moment, key);
  const fields = { rule_json, text: SETTING_TEXT[key], status: "approved" as const, approved_at: now };
  if (existing) return repo.playbookRules.update(existing.id, fields)!;
  return repo.playbookRules.insert({ id: newId("rule"), merchant_id: merchantId, moment, source: "merchant", ...fields });
}
