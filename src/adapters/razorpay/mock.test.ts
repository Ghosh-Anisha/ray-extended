import { afterEach } from "vitest";
import { openMigratedDb, type Db } from "@/db/client";
import { SEED_NOW, seed } from "@/db/seed";
import { fakeClock } from "../clock";
import { razorpayContract } from "./contract";
import { createMockRazorpay } from "./mock";

let db: Db | undefined;
afterEach(() => db?.$client.close());

razorpayContract("mock", () => {
  db = openMigratedDb(":memory:");
  seed(db);
  const clock = fakeClock(SEED_NOW);
  const rzp = createMockRazorpay(db, clock, "m_leafy_bakes");
  return {
    rzp,
    fx: {
      capturedPayment: async () => rzp.simulatePayment({ amount: 129_900, status: "captured" }),
      authorizedPayment: async () => rzp.simulatePayment({ amount: 49_900, status: "authorized" }),
      orderWithTwoPayments: "order_LB1235",
      openDisputeId: "disp_LB_meera",
      activeSubscriptionId: undefined,
      pendingInvoiceSubscriptionId: undefined,
      advanceClock: (ms) => clock.advance(ms),
    },
  };
});

// Subscriptions live on other merchants' accounts.
razorpayContract("mock (subscriptions)", () => {
  db = openMigratedDb(":memory:");
  seed(db);
  const clock = fakeClock(SEED_NOW);
  const tutorials = createMockRazorpay(db, clock, "m_sharma_tutorials");
  const fitloop = createMockRazorpay(db, clock, "m_fitloop");
  return {
    rzp: {
      ...tutorials,
      fetchPendingInvoice: (id: string) => fitloop.fetchPendingInvoice(id),
    },
    fx: { activeSubscriptionId: "sub_STU_neha", pendingInvoiceSubscriptionId: "sub_FL_karan" },
  };
});
