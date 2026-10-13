-- Step 9, subscriptions: when the subscriber approved the mandate and its
-- reference, when Razorpay sent the pre-debit notice for a cycle, the offer
-- linked to a subscription, and the merchant's discount save offer (an
-- offer made in the Razorpay Dashboard, and its percent off). How long a
-- pause lasts (null: 30 days). Calling subscribers above a value is a
-- playbook rule row, not a column.
ALTER TABLE `mandates` ADD `authorised_at` integer;--> statement-breakpoint
ALTER TABLE `mandates` ADD `auth_ref` text;--> statement-breakpoint
ALTER TABLE `sub_invoices` ADD `notified_at` integer;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `offer_id` text;--> statement-breakpoint
ALTER TABLE `merchants` ADD `sub_pause_days` integer;--> statement-breakpoint
ALTER TABLE `merchants` ADD `sub_discount_offer_id` text;--> statement-breakpoint
ALTER TABLE `merchants` ADD `sub_discount_percent` integer;
