// Runs once when the server starts. The demo world is seeded here (when the
// database has none, or an older one), so the first page is as fast as any
// other and nothing seeds per request. On the real clock, starting the engine
// also starts its 30 s timer tick, so timers fire without anyone opening a page.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { ensureDemoWorld } = await import("@/demo/world");
    await ensureDemoWorld();
  }
}
