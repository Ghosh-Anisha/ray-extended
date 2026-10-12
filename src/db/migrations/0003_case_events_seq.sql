-- case_events.seq: monotonic insert order, so events at the same timestamp
-- read back in the order they were written. The repository sets it to
-- max + 1 on insert; this trigger rejects a missing or non-increasing seq.
-- No backfill: UPDATE on case_events is blocked, and seeded databases have
-- no events before this migration.
ALTER TABLE `case_events` ADD `seq` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `case_events_seq_unique` ON `case_events` (`seq`);--> statement-breakpoint
CREATE TRIGGER `case_events_seq_monotonic` BEFORE INSERT ON `case_events`
WHEN NEW.seq IS NULL OR NEW.seq <= (SELECT coalesce(max(seq), 0) FROM case_events)
BEGIN
  SELECT RAISE(ABORT, 'case_events.seq must increase on every insert');
END;
