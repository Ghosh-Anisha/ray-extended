// History for My dashboard and the Grow cards (docs/ui-rebuild.md 12 and 13),
// so the suggestions make sense on first load:
//   - six carts above ₹5,000 that were started and never paid in the last
//     30 days (orders with no payment), next to the paid ones already seeded;
//   - what the merchant asked about this week: success rate four times.
import type { Db } from "../client";
import { createRepository } from "../repository";
import { uiState } from "../schema";
import { DAY, HOUR, ist, LEAFY, rupees } from "./demo-people";

const CARTS = [
  { at: "2026-09-16T20:15", inr: 5400 },
  { at: "2026-09-22T11:40", inr: 7500 },
  { at: "2026-09-29T19:05", inr: 6200 },
  { at: "2026-10-03T21:30", inr: 8800 },
  { at: "2026-10-08T13:10", inr: 5900 },
  { at: "2026-10-11T18:45", inr: 9400 },
];

export function seedDashboardHistory(db: Db, now: number) {
  const repo = createRepository(db);
  CARTS.forEach((c, i) => {
    repo.rzpOrders.insert({ id: `order_LB_cart${i + 1}`, merchant_id: LEAFY, status: "attempted", amount: rupees(c.inr), receipt: `wc_cart_${i + 1}`, created_at: ist(c.at) });
  });
  // Success rate four times this week; refunds and disputes once each.
  const asks = [
    { kind: "success_rate", at: now - 6 * DAY + 3 * HOUR },
    { kind: "success_rate", at: now - 4 * DAY + 5 * HOUR },
    { kind: "refunds", at: now - 3 * DAY },
    { kind: "success_rate", at: now - 2 * DAY + 2 * HOUR },
    { kind: "disputes", at: now - DAY },
    { kind: "success_rate", at: now - 20 * HOUR },
  ];
  db.insert(uiState).values({ merchant_id: LEAFY, key: "dash.asks", value: asks, updated_at: now }).run();
}
