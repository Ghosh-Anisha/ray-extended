-- Record on each inbound webhook delivery and message which case took it,
-- or why none did (no flow picked it up).
ALTER TABLE `messages` ADD `handled_case_id` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `unmatched_reason` text;--> statement-breakpoint
ALTER TABLE `webhook_deliveries` ADD `handled_case_id` text;--> statement-breakpoint
ALTER TABLE `webhook_deliveries` ADD `unmatched_reason` text;