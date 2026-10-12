-- Step 9, subscriptions: when the subscriber approved the mandate and its
-- reference, when Razorpay sent the pre-debit notice for a cycle, and two
-- playbook values per merchant: the subscriber value above which RAY may
-- call (null: no calls), and how long a pause lasts (null: 30 days).
ALTER TABLE `mandates` ADD `authorised_at` integer;--> statement-breakpoint
ALTER TABLE `mandates` ADD `auth_ref` text;--> statement-breakpoint
ALTER TABLE `sub_invoices` ADD `notified_at` integer;--> statement-breakpoint
ALTER TABLE `merchants` ADD `sub_call_value_limit` integer;--> statement-breakpoint
ALTER TABLE `merchants` ADD `sub_pause_days` integer;
