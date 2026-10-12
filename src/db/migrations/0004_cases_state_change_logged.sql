-- A case's state may only change right after its state_changed event is
-- written: the newest case_events row must be that case's state_changed note
-- from the old state to the new one. The state machine in src/engine does
-- this; any other write to cases.state is rejected.
CREATE TRIGGER `cases_state_change_logged` BEFORE UPDATE OF `state` ON `cases`
WHEN NEW.state IS NOT OLD.state AND NOT EXISTS (
  SELECT 1 FROM case_events
  WHERE case_id = NEW.id
    AND seq = (SELECT max(seq) FROM case_events)
    AND json_extract(payload, '$.kind') = 'state_changed'
    AND json_extract(payload, '$.from') = OLD.state
    AND json_extract(payload, '$.to') = NEW.state
)
BEGIN
  SELECT RAISE(ABORT, 'case state changes must go through the state machine');
END;
