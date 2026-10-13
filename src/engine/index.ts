// The engine for this server process, wired to the adapters. Flows register
// their specialists here as they are built (Step 7 onward). On the real clock
// it also starts the 30 s timer tick.
import { getAdapters } from "@/adapters";
import { createChargebacksSpecialist } from "@/flows/chargebacks";
import { createPaidNoOrderSpecialist } from "@/flows/paid-no-order";
import { createInternationalSpecialist } from "@/flows/international";
import { createSubscriptionsSpecialist } from "@/flows/subscriptions";
import { createCollectSpecialist } from "@/flows/collect";
import { createEngine, type Engine } from "./engine";
import { createRegistry, type Registry } from "./specialist";
import { startRealClockTicker } from "./ticker";

export { createEngine, type Engine, type HandleResult } from "./engine";
export { createRegistry, type Specialist } from "./specialist";

const holder = globalThis as unknown as { __rayEngine?: Engine };

export function buildRegistry(): Registry {
  return createRegistry([createPaidNoOrderSpecialist(), createInternationalSpecialist(), createSubscriptionsSpecialist(), createChargebacksSpecialist(), createCollectSpecialist()]);
}

export function getEngine(): Engine {
  if (!holder.__rayEngine) {
    const a = getAdapters();
    holder.__rayEngine = createEngine({ db: a.db, clock: a.clock, adapters: a, registry: buildRegistry() });
    startRealClockTicker(a.clockMode, holder.__rayEngine);
  }
  return holder.__rayEngine;
}
