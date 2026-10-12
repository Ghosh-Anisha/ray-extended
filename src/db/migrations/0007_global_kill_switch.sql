-- The global kill switch (Step 5). One row, id "global"; no row means off.
CREATE TABLE `global_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`kill_switch` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL
);
