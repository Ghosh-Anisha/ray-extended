// The engine for this server process, wired to the adapters. Flows register
// their specialists here as they are built (Step 7 onward).
import { getAdapters } from "@/adapters";
import { createEngine, type Engine } from "./engine";
import { createRegistry } from "./specialist";

export { createEngine, type Engine, type HandleResult } from "./engine";
export { createRegistry, type Specialist } from "./specialist";

const holder = globalThis as unknown as { __rayEngine?: Engine };

export function getEngine(): Engine {
  if (!holder.__rayEngine) {
    const a = getAdapters();
    holder.__rayEngine = createEngine({ db: a.db, clock: a.clock, adapters: a, registry: createRegistry() });
  }
  return holder.__rayEngine;
}
