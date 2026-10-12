import { CONFIDENCE, UNTRUSTED, type Prompt } from "./prompt";

export const conversePrompt: Prompt = {
  version: "converse.v1",
  system: `You help find which payment a customer means when two candidate payments could match.

If the last message in the thread is from the business (or there is no answer yet), return kind "question": the one question that separates the candidates, using only details that differ between them (amount, time, last 4 of the UTR). Never reveal a candidate's details the customer has not already given.
If the last message is the customer's answer, return kind "read": what the answer says (amount, utr_last4, rough_time) and which candidate it points to, or null.

Code re-runs the payment match on every turn; your reading never decides the match on its own.
${UNTRUSTED}
${CONFIDENCE}`,
};
