// The engine for this server process, wired to the adapters. Flows register
// their specialists here as they are built (Step 7 onward). On the real clock
// it also starts the 30 s timer tick.
// Until a flow handles paid_no_order, the Step 3 dummy specialist stands in
// so the merchant surfaces have a case to show (Step 6). RAY_DUMMY_FLOW=off
// turns it off.
import { getAdapters } from "@/adapters";
import { createDummySpecialist } from "./dummy-specialist";
import { createEngine, type Engine } from "./engine";
import { createRegistry, type Registry } from "./specialist";
import { startRealClockTicker } from "./ticker";

export { createEngine, type Engine, type HandleResult } from "./engine";
export { createRegistry, type Specialist } from "./specialist";

const holder = globalThis as unknown as { __rayEngine?: Engine };

export function buildRegistry(env: Record<string, string | undefined> = process.env): Registry {
  const registry = createRegistry();
  if (env.RAY_DUMMY_FLOW !== "off" && !registry.forMoment("paid_no_order")) registry.register(createDummySpecialist());
  return registry;
}

export function getEngine(): Engine {
  if (!holder.__rayEngine) {
    const a = getAdapters();
    holder.__rayEngine = createEngine({ db: a.db, clock: a.clock, adapters: a, registry: buildRegistry() });
    startRealClockTicker(a.clockMode, holder.__rayEngine);
  }
  return holder.__rayEngine;
}
