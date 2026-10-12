-- Step 11: buyers get consent rows on every channel, and invoices a taxable value.
-- messaging_consents is rebuilt so a row names a customer or a buyer (exactly
-- one). Every existing row is copied over unchanged.
CREATE TABLE `messaging_consents_new` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text,
	`buyer_id` text,
	`channel` text NOT NULL,
	`status` text NOT NULL,
	`source` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`buyer_id`) REFERENCES `buyers`(`id`) ON UPDATE no action ON DELETE no action,
	CHECK ((`customer_id` IS NULL) <> (`buyer_id` IS NULL))
);
--> statement-breakpoint
INSERT INTO `messaging_consents_new` (`id`, `customer_id`, `buyer_id`, `channel`, `status`, `source`, `updated_at`)
	SELECT `id`, `customer_id`, NULL, `channel`, `status`, `source`, `updated_at` FROM `messaging_consents`;
--> statement-breakpoint
DROP TABLE `messaging_consents`;
--> statement-breakpoint
ALTER TABLE `messaging_consents_new` RENAME TO `messaging_consents`;
--> statement-breakpoint
CREATE UNIQUE INDEX `messaging_consents_customer_channel` ON `messaging_consents` (`customer_id`,`channel`);
--> statement-breakpoint
CREATE UNIQUE INDEX `messaging_consents_buyer_channel` ON `messaging_consents` (`buyer_id`,`channel`);
--> statement-breakpoint
ALTER TABLE `invoices` ADD `taxable_value` integer;
