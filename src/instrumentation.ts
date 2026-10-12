// Runs once when the server starts. On the real clock, starting the engine
// starts its 30 s timer tick, so timers fire without anyone opening a page.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.CLOCK_MODE === "real") {
    const { getEngine } = await import("@/engine");
    getEngine();
  }
}
