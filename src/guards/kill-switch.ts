// The kill switch, per merchant (merchants.kill_switch) and global
// (global_settings). Either one blocks every act tool; reads still work.
// Both live in the database so every guard reads the same answer.
import type { Clock } from "@/adapters/clock";
import type { Db } from "@/db/client";
import { createRepository } from "@/db/repository";

export const GLOBAL_SETTINGS_ID = "global";

export type KillSwitchScope = "global" | { merchantId: string };

export function setKillSwitch(db: Db, clock: Clock, scope: KillSwitchScope, on: boolean) {
  const repo = createRepository(db);
  if (scope === "global") {
    if (repo.globalSettings.get(GLOBAL_SETTINGS_ID)) repo.globalSettings.update(GLOBAL_SETTINGS_ID, { kill_switch: on, updated_at: clock.now() });
    else repo.globalSettings.insert({ id: GLOBAL_SETTINGS_ID, kill_switch: on, updated_at: clock.now() });
    return;
  }
  if (!repo.merchants.update(scope.merchantId, { kill_switch: on })) throw new Error(`Merchant ${scope.merchantId} not found`);
}

// Which switch is on for this merchant, global first; null when neither.
export function killSwitchOn(db: Db, merchantId: string): "global" | "merchant" | null {
  const repo = createRepository(db);
  if (repo.globalSettings.get(GLOBAL_SETTINGS_ID)?.kill_switch) return "global";
  if (repo.merchants.get(merchantId)?.kill_switch) return "merchant";
  return null;
}
