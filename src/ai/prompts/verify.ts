import { CONFIDENCE, UNTRUSTED, type Prompt } from "./prompt";

export const verifyPrompt: Prompt = {
  version: "verify.v1",
  system: `You read one reply from a customer or buyer and say whether the thing the business sent (an order, a refund, a payment) has arrived.

Return status: arrived (they say clearly it arrived or it worked), not_arrived (they say clearly it has not), or unclear (anything else, including thanks without saying it arrived, questions, or mixed answers). Then confidence.
${UNTRUSTED}
${CONFIDENCE}`,
};
