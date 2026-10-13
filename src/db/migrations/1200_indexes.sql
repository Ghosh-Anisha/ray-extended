-- UI rebuild, speed (docs/ui-rebuild.md section 8): the lookups every screen
-- makes (a merchant's cases by state, a case's events, messages, timers and
-- actions) now use an index instead of reading the whole table. No data
-- changes; the append-only triggers on case_events are untouched.
CREATE INDEX IF NOT EXISTS `cases_merchant_state` ON `cases` (`merchant_id`, `state`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `cases_payment` ON `cases` (`payment_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `case_events_case_at` ON `case_events` (`case_id`, `at`, `seq`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `case_events_evidence` ON `case_events` (`evidence_ref`, `type`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `messages_case` ON `messages` (`case_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `messages_to_at` ON `messages` (`to`, `at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `messages_from_at` ON `messages` (`from`, `at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `timers_case` ON `timers` (`case_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `timers_due` ON `timers` (`fired_at`, `cancelled_at`, `due_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `actions_case_status` ON `actions` (`case_id`, `status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `alerts_merchant_sent` ON `alerts` (`merchant_id`, `sent_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `rzp_payments_merchant_created` ON `rzp_payments` (`merchant_id`, `created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `store_orders_merchant` ON `store_orders` (`merchant_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `store_orders_payment` ON `store_orders` (`payment_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `customers_merchant` ON `customers` (`merchant_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `buyers_merchant` ON `buyers` (`merchant_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `invoices_merchant_status` ON `invoices` (`merchant_id`, `status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `disputes_merchant` ON `disputes` (`merchant_id`, `created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `subscriptions_merchant` ON `subscriptions` (`merchant_id`, `status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `playbook_rules_merchant` ON `playbook_rules` (`merchant_id`, `moment`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `webhook_deliveries_payment` ON `webhook_deliveries` (`payment_id`);
