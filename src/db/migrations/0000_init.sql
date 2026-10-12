CREATE TABLE `actions` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`tool` text NOT NULL,
	`args` text NOT NULL,
	`guard_result` text,
	`approved_by` text,
	`idempotency_key` text NOT NULL,
	`status` text NOT NULL,
	`result` text,
	`run_after` integer,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `actions_idempotency_key_unique` ON `actions` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE `ai_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text,
	`job` text NOT NULL,
	`mode` text NOT NULL,
	`model` text,
	`input_hash` text NOT NULL,
	`output` text,
	`valid` integer NOT NULL,
	`ms` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`case_id` text,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`channel` text NOT NULL,
	`sent_at` integer NOT NULL,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `bank_credits` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`amount` integer NOT NULL,
	`remark` text NOT NULL,
	`utr` text NOT NULL,
	`date` integer NOT NULL,
	`matched_invoices` text NOT NULL,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `buyers` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`name` text NOT NULL,
	`contact_name` text NOT NULL,
	`email` text,
	`phone` text,
	`avg_days_late` integer NOT NULL,
	`pay_history` text NOT NULL,
	`usual_tds_rate` real NOT NULL,
	`key_account` integer NOT NULL,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `case_events` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`at` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`evidence_ref` text,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `cases` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`moment` text NOT NULL,
	`situation` text,
	`state` text NOT NULL,
	`confidence` text NOT NULL,
	`side` text,
	`razorpay_plugin` integer DEFAULT false NOT NULL,
	`covered` integer DEFAULT false NOT NULL,
	`amount` integer,
	`payment_id` text,
	`store_order_id` text,
	`cause` text,
	`promised_by` integer,
	`opened_at` integer NOT NULL,
	`closed_at` integer,
	`outcome` text,
	`counts_as_saved` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`name` text NOT NULL,
	`email` text,
	`phone` text,
	`language` text DEFAULT 'en' NOT NULL,
	`country` text DEFAULT 'IN' NOT NULL,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `disputes` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`payment_id` text NOT NULL,
	`reason_code` text NOT NULL,
	`reason` text NOT NULL,
	`network` text NOT NULL,
	`phase` text NOT NULL,
	`amount` integer NOT NULL,
	`deducted` integer NOT NULL,
	`respond_by` integer NOT NULL,
	`status` text NOT NULL,
	`lane` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payment_id`) REFERENCES `rzp_payments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `downtimes` (
	`id` text PRIMARY KEY NOT NULL,
	`method` text NOT NULL,
	`bank` text,
	`start` integer NOT NULL,
	`end` integer
);
--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`buyer_id` text NOT NULL,
	`number` text NOT NULL,
	`amount` integer NOT NULL,
	`issued_at` integer NOT NULL,
	`due_date` integer NOT NULL,
	`accepted_at` integer,
	`status` text NOT NULL,
	`paid_amount` integer DEFAULT 0 NOT NULL,
	`key_account` integer NOT NULL,
	`disputed_part` integer,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`buyer_id`) REFERENCES `buyers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `mandates` (
	`id` text PRIMARY KEY NOT NULL,
	`subscription_id` text NOT NULL,
	`method` text NOT NULL,
	`token_id` text,
	`status` text NOT NULL,
	`max_amount` integer NOT NULL,
	`expires_at` integer,
	FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `memory` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`vector` text NOT NULL,
	`merchant_id` text,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `merchants` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`business_type` text NOT NULL,
	`store_platform` text NOT NULL,
	`gmv_band` text NOT NULL,
	`risk_band` text NOT NULL,
	`failure_history` text NOT NULL,
	`cluster` text NOT NULL,
	`wave` integer NOT NULL,
	`ray_on` integer NOT NULL,
	`connector_on` integer NOT NULL,
	`whatsapp_on` integer NOT NULL,
	`banking_plus` integer NOT NULL,
	`udyam` integer NOT NULL,
	`approval_limit` integer NOT NULL,
	`kill_switch` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text,
	`channel` text NOT NULL,
	`direction` text NOT NULL,
	`from` text NOT NULL,
	`to` text NOT NULL,
	`sender_mode` text,
	`body` text NOT NULL,
	`template_id` text,
	`within_24h` integer,
	`at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `playbook_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`moment` text NOT NULL,
	`rule_json` text NOT NULL,
	`text` text NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`approved_at` integer,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `plugin_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text,
	`plugin` text NOT NULL,
	`plugin_version` text NOT NULL,
	`failure` text NOT NULL,
	`reported_at` integer NOT NULL,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `promises` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`buyer_id` text NOT NULL,
	`promised_date` integer NOT NULL,
	`amount` integer NOT NULL,
	`made_at` integer NOT NULL,
	`status` text NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`buyer_id`) REFERENCES `buyers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `rzp_links` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`payment_id` text,
	`short_url` text,
	`status` text NOT NULL,
	`amount` integer NOT NULL,
	`currency` text DEFAULT 'INR' NOT NULL,
	`method` text,
	`contact` text,
	`email` text,
	`vpa` text,
	`card_last4` text,
	`card_country` text,
	`utr` text,
	`error_code` text,
	`error_source` text,
	`error_reason` text,
	`receipt` text,
	`created_at` integer NOT NULL,
	`captured_at` integer,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payment_id`) REFERENCES `rzp_payments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `rzp_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`status` text NOT NULL,
	`amount` integer NOT NULL,
	`currency` text DEFAULT 'INR' NOT NULL,
	`method` text,
	`contact` text,
	`email` text,
	`vpa` text,
	`card_last4` text,
	`card_country` text,
	`utr` text,
	`error_code` text,
	`error_source` text,
	`error_reason` text,
	`receipt` text,
	`created_at` integer NOT NULL,
	`captured_at` integer,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `rzp_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`order_id` text,
	`status` text NOT NULL,
	`amount` integer NOT NULL,
	`currency` text DEFAULT 'INR' NOT NULL,
	`method` text,
	`contact` text,
	`email` text,
	`vpa` text,
	`card_last4` text,
	`card_country` text,
	`utr` text,
	`error_code` text,
	`error_source` text,
	`error_reason` text,
	`receipt` text,
	`created_at` integer NOT NULL,
	`captured_at` integer,
	`base_amount` integer,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `rzp_orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `rzp_refunds` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`payment_id` text NOT NULL,
	`status` text NOT NULL,
	`amount` integer NOT NULL,
	`currency` text DEFAULT 'INR' NOT NULL,
	`method` text,
	`contact` text,
	`email` text,
	`vpa` text,
	`card_last4` text,
	`card_country` text,
	`utr` text,
	`error_code` text,
	`error_source` text,
	`error_reason` text,
	`receipt` text,
	`created_at` integer NOT NULL,
	`captured_at` integer,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payment_id`) REFERENCES `rzp_payments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `store_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`number` text NOT NULL,
	`merchant_id` text NOT NULL,
	`customer_id` text,
	`status` text NOT NULL,
	`status_history` text NOT NULL,
	`razorpay_order_id` text,
	`receipt` text,
	`payment_id` text,
	`total` integer NOT NULL,
	`items` text NOT NULL,
	`stock` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sub_invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`subscription_id` text NOT NULL,
	`amount` integer NOT NULL,
	`status` text NOT NULL,
	`attempts` integer NOT NULL,
	`payment_id` text,
	`error_reason` text,
	`billing_start` integer NOT NULL,
	`billing_end` integer NOT NULL,
	FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`status` text NOT NULL,
	`plan` text NOT NULL,
	`amount` integer NOT NULL,
	`retries_left` integer NOT NULL,
	`pending_invoice_id` text,
	`b2b` integer NOT NULL,
	`lifetime_value` integer NOT NULL,
	`resume_at` integer,
	`started_at` integer NOT NULL,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `timers` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`kind` text NOT NULL,
	`due_at` integer NOT NULL,
	`fired_at` integer,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`event_id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`event` text NOT NULL,
	`url` text NOT NULL,
	`http_status` integer,
	`response_body` text,
	`delivered_at` integer NOT NULL,
	`plugin` text,
	`plugin_version` text,
	`processed` integer NOT NULL,
	`cron_note` text,
	`payment_id` text,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action
);
