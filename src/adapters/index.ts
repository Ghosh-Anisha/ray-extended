// One set of adapters per server process. Flows, tools and API routes get
// them from here and only call the interfaces. The clock is fake, starting at
// the seed time, so the dev panel can move it forward.
import { openMigratedDb, type Db } from "@/db/client";
import { SEED_NOW } from "@/db/seed";
import { fakeClock, type FakeClock } from "./clock";
import { createMessagingSim, type MessagingSim } from "./messaging";
import { createRazorpay, loadRazorpayConfig, type RazorpayAdapter } from "./razorpay";
import { createStoreSim, type StoreSim } from "./store";
import { createWebhookSim, type WebhookSim } from "./webhooks";

export type Adapters = {
  db: Db;
  clock: FakeClock;
  razorpay(merchantId: string): RazorpayAdapter;
  store: StoreSim;
  messaging: MessagingSim;
  webhooks: WebhookSim;
};

export function createAdapters(db: Db, clock: FakeClock, env: Record<string, string | undefined> = process.env): Adapters {
  const config = loadRazorpayConfig(env);
  const store = createStoreSim(db, clock);
  return {
    db,
    clock,
    razorpay: (merchantId) => createRazorpay(config, db, clock, merchantId),
    store,
    messaging: createMessagingSim(db, clock),
    webhooks: createWebhookSim(db, clock, store),
  };
}

const holder = globalThis as unknown as { __rayAdapters?: Adapters };

export function getAdapters(): Adapters {
  holder.__rayAdapters ??= createAdapters(openMigratedDb(), fakeClock(SEED_NOW));
  return holder.__rayAdapters;
}
