-- Step 5b, voice: voice note and call fields on messages, calling hours
-- and the urgent-call opt-in on merchants, and how simulated callees answer.
-- messages.channel gains voice_note and call, messaging_consents.channel
-- gains call (text columns, no constraint to change).
CREATE TABLE `call_sims` (
	`callee` text PRIMARY KEY NOT NULL,
	`outcome` text NOT NULL,
	`reply` text,
	`promise` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `merchants` ADD `calling_hours_start` integer DEFAULT 600 NOT NULL;--> statement-breakpoint
ALTER TABLE `merchants` ADD `calling_hours_end` integer DEFAULT 1140 NOT NULL;--> statement-breakpoint
ALTER TABLE `merchants` ADD `urgent_call_opt_in` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `transcript` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `audio_ref` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `duration_s` integer;