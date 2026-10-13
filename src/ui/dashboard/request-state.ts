export const DASHBOARD_REQUEST_TIMEOUT_MS = 12_000;

export function dashboardRequestError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "The dashboard setup took too long. Check that the app can reach its shared database, then try again.";
  }
  return error instanceof Error ? error.message : "That didn't work. Try again.";
}
