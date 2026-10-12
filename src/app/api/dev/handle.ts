import { ZodError } from "zod";

// Dev panel routes: run the action, answer 400 with a plain message on failure.
export async function handle(fn: () => Promise<unknown>): Promise<Response> {
  try {
    return Response.json({ ok: true, result: await fn() });
  } catch (e) {
    const message = e instanceof ZodError ? e.issues.map((i) => i.message).join("; ") : e instanceof Error ? e.message : "Failed";
    return Response.json({ ok: false, error: message }, { status: 400 });
  }
}
