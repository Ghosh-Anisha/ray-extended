-- case_events is append only (CLAUDE.md rule 8).
CREATE TRIGGER `case_events_no_update` BEFORE UPDATE ON `case_events`
BEGIN
  SELECT RAISE(ABORT, 'case_events is append only');
END;
--> statement-breakpoint
CREATE TRIGGER `case_events_no_delete` BEFORE DELETE ON `case_events`
BEGIN
  SELECT RAISE(ABORT, 'case_events is append only');
END;
