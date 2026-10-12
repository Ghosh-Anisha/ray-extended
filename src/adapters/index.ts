// One set of adapters per server process. Flows, tools and API routes get
// them from here and only call the interfaces. The clock is fake by default,
// starting at the seed time, so the dev panel can move it forward.
// CLOCK_MODE=real uses the real clock, which cannot be moved.
import { openMigratedDb, type Db } from "@/db/client";
import { SEED_NOW } from "@/db/seed";
import { fakeClock, lockedRealClock, type FakeClock } from "./clock";
import { createMessagingSim, type MessagingSim } from "./messaging";
import { createRazorpay, loadRazorpayConfig, type RazorpayAdapter } from "./razorpay";
import { createStoreSim, type StoreSim } from "./store";
import { createVoice, loadVoiceConfig, type VoiceAdapter } from "./voice";
import { createWebhookSim, type WebhookSim } from "./webhooks";

export type Adapters = {
  db: Db;
  clock: FakeClock;
  clockMode: "fake" | "real";
  razorpay(merchantId: string): RazorpayAdapter;
  store: StoreSim;
  messaging: MessagingSim;
  webhooks: WebhookSim;
  voice: VoiceAdapter;
};

export function createAdapters(
  db: Db,
  clock: FakeClock,
  env: Record<string, string | undefined> = process.env,
  clockMode: "fake" | "real" = "fake",
): Adapters {
  const config = loadRazorpayConfig(env);
  const store = createStoreSim(db, clock);
  return {
    db,
    clock,
    clockMode,
    razorpay: (merchantId) => createRazorpay(config, db, clock, merchantId),
    store,
    messaging: createMessagingSim(db, clock),
    webhooks: createWebhookSim(db, clock, store),
    voice: createVoice(db, clock, loadVoiceConfig(env)),
  };
}

const holder = globalThis as unknown as { __rayAdapters?: Adapters };

export function getAdapters(): Adapters {
  if (!holder.__rayAdapters) {
    const real = process.env.CLOCK_MODE === "real";
    const clock = real ? lockedRealClock() : fakeClock(SEED_NOW);
    holder.__rayAdapters = createAdapters(openMigratedDb(), clock, process.env, real ? "real" : "fake");
  }
  return holder.__rayAdapters;
}
