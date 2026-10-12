-- Step 8, card declined abroad: simulated Razorpay international settings,
-- the signals RAY reads (Vulcan, risk hold, 3DS), MoneySaver accounts and the
-- bank transfers landing in them. The Drizzle tables live in
-- src/flows/international/schema.ts.
CREATE TABLE `intl_settings` (
	`merchant_id` text PRIMARY KEY NOT NULL,
	`international_on` integer NOT NULL,
	`limit_inr` integer NOT NULL,
	`currencies` text NOT NULL,
	`networks` text NOT NULL,
	`checkout` text NOT NULL,
	`paypal_on` integer NOT NULL,
	`moneysaver_on` integer NOT NULL,
	`billing_address_required` integer NOT NULL,
	`buyer_type` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `intl_payment_signals` (
	`payment_id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`vulcan_result` text NOT NULL,
	`risk_hold` text NOT NULL,
	`three_ds` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `intl_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`currency` text NOT NULL,
	`bank_name` text NOT NULL,
	`account_name` text NOT NULL,
	`account_number` text NOT NULL,
	`routing_label` text NOT NULL,
	`routing` text NOT NULL,
	`swift` text NOT NULL,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `intl_transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`account_id` text NOT NULL,
	`currency` text NOT NULL,
	`amount` integer NOT NULL,
	`base_amount` integer NOT NULL,
	`remitter_name` text NOT NULL,
	`remitter_reference` text NOT NULL,
	`invoice_ref` text,
	`received_at` integer NOT NULL,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `intl_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
