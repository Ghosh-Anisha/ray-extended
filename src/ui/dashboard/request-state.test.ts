import { describe, expect, it } from "vitest";
import { DASHBOARD_REQUEST_TIMEOUT_MS, dashboardRequestError } from "./request-state";

describe("dashboard setup request state", () => {
  it("bounds a stuck request and gives an actionable retry message", () => {
    expect(DASHBOARD_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(12_000);
    expect(dashboardRequestError(new DOMException("aborted", "AbortError"))).toMatch(/shared database.*try again/i);
  });

  it("preserves a server error instead of showing a success state", () => {
    expect(dashboardRequestError(new Error("Storage unavailable"))).toBe("Storage unavailable");
  });
});
