// Runs the contract against Razorpay test mode. Skipped unless
// RAZORPAY_MODE=test, with test keys in .env.local.
import { loadRazorpayConfig } from ".";
import { razorpayContract } from "./contract";
import { createTestClient } from "./test-client";

const enabled = process.env.RAZORPAY_MODE === "test";

razorpayContract(
  "test mode",
  () => {
    const config = loadRazorpayConfig();
    if (config.mode !== "test") throw new Error("RAZORPAY_MODE=test is required");
    return { rzp: createTestClient(config.keys()), fx: {} };
  },
  { skip: !enabled },
);
