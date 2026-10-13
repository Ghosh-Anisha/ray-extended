// The coach-mark sequences (docs/ui-rebuild.md section 10). A screen sequence
// shows on the first visit; a tour is opened by "Try it" (?tour=name). Steps
// whose element is not on the page are skipped, so a tour never points at
// nothing.
export type CoachStep = { target: string; text: string; end?: string };

export const SCREEN_STEPS: Record<string, CoachStep[]> = {
  home: [
    { target: '[data-coach="capabilities"]', text: "Everything RAY can do for you. Each card says if it is On, ready to Try, or Coming soon." },
    { target: '[data-coach="suggestions"]', text: "RAY also suggests changes from your own numbers. You decide: Turn on or Not now." },
    { target: '[data-coach="try-it"]', text: "Try it opens a short example on Leafy Bakes, with RAY pointing things out." },
  ],
  dashboard: [
    { target: '[data-coach="dash-setup"]', text: "Three quick questions. They are already picked from your data, so you can just build." },
    { target: '[data-coach="dash-widgets"]', text: "Each number comes from your payments and cases, with its definition underneath." },
    { target: '[data-coach="dash-ask"]', text: "Ask for a widget in plain words, like “show refunds by product”." },
    { target: '[data-coach="dash-watch"]', text: "RAY watches pinned numbers against your normal. When one moves, you get a badge and a Why?." },
    { target: '[data-coach="dash-reports"]', text: "Reports in words: a short summary on top, then the table. Send it to your CA on WhatsApp." },
  ],
};

export const TOURS: Record<string, CoachStep[]> = {
  paid_no_order: [
    { target: ".inbox-top", text: "Customers who paid but whose order never showed up land here, biggest money first." },
    { target: "table.data.mail tbody tr, .case-card", text: "Open one. RAY has already checked the payment, the webhook and the store." },
  ],
  international: [
    { target: ".inbox-top", text: "Cards declined abroad. RAY works out if it is the bank, the limit or your settings." },
    { target: "table.data.mail tbody tr, .case-card", text: "Open one to see the fix RAY proposes, such as a payment link for the customer." },
  ],
  subscription: [
    { target: ".inbox-top", text: "Subscribers who are about to stop. RAY offers a pause, a discount or a retry." },
    { target: "table.data.mail tbody tr, .case-card", text: "Open one to pick the offer. RAY can turn a repeated choice into a rule." },
  ],
  chargeback: [
    { target: ".inbox-top", text: "Disputes with their reply deadline. RAY gathers the proof for you." },
    { target: "table.data.mail tbody tr, .case-card", text: "Open one to see the evidence RAY found and approve the reply." },
  ],
  collect: [
    { target: ".inbox-top", text: "Overdue invoices. RAY reminds the buyer, notes each promise and matches the bank credit." },
    { target: "table.data.mail tbody tr, .case-card", text: "Open one to see what was promised and what RAY sent." },
  ],
  grow: [
    { target: '[data-coach="grow-card"]', text: "RAY found this in your own orders: big carts that never got paid." },
    { target: '[data-coach="grow-actions"]', text: "Turn on, or Not now. Two weeks later RAY shows what changed, before and after." },
  ],
  dashboard: SCREEN_STEPS.dashboard,
};

export const SEEN_PREFIX = "ray-coach:";
export const REPLAY_EVENT = "ray-coach-replay";
