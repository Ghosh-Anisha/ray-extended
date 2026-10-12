-- Step 10, chargebacks. The flow's own tables (declared in
-- src/flows/chargebacks/schema.ts):
-- cb_settings: how a merchant's dispute responses are filed (Dispute
--   Responder, the Disputes API, or a pack the merchant uploads).
-- cb_fraud_signals: Simulated device, IP, address and Vulcan result per
--   payment. Read, never re-scored.
-- cb_buyer_protection_claims: Simulated Buyer Protection claims. An open
--   claim on the disputed payment is evidence for the pack.
CREATE TABLE `cb_settings` (
	`merchant_id` text PRIMARY KEY NOT NULL REFERENCES `merchants`(`id`),
	`filing` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cb_fraud_signals` (
	`payment_id` text PRIMARY KEY NOT NULL REFERENCES `rzp_payments`(`id`),
	`merchant_id` text NOT NULL REFERENCES `merchants`(`id`),
	`vulcan_result` text NOT NULL,
	`device_seen_before` integer NOT NULL,
	`ip_country` text NOT NULL,
	`address_matches` integer NOT NULL,
	`checked_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cb_buyer_protection_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL REFERENCES `merchants`(`id`),
	`payment_id` text NOT NULL REFERENCES `rzp_payments`(`id`),
	`status` text NOT NULL,
	`summary` text NOT NULL,
	`opened_at` integer NOT NULL
);
