-- Persist simulated store settings, product stock, messaging consents and dispute drafts.
CREATE TABLE `messaging_consents` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`channel` text NOT NULL,
	`status` text NOT NULL,
	`source` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messaging_consents_customer_channel` ON `messaging_consents` (`customer_id`,`channel`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`sku` text NOT NULL,
	`name` text NOT NULL,
	`price` integer NOT NULL,
	`stock` integer NOT NULL,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_merchant_sku` ON `products` (`merchant_id`,`sku`);--> statement-breakpoint
CREATE TABLE `store_settings` (
	`merchant_id` text PRIMARY KEY NOT NULL,
	`webhook_enabled` integer NOT NULL,
	`site_status` text NOT NULL,
	`plugin` text NOT NULL,
	`plugin_version` text NOT NULL,
	`failure_mode` text NOT NULL,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `disputes` ADD `draft_json` text;--> statement-breakpoint
ALTER TABLE `disputes` ADD `draft_status` text;