-- UI rebuild U6: what the merchant set up on My dashboard and the lever cards
-- on Home. One JSON value per merchant and key. No other table changes.
CREATE TABLE IF NOT EXISTS `ui_state` (
	`merchant_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `ui_state_merchant_key` ON `ui_state` (`merchant_id`, `key`);
