-- Lane 6 / L6-B -- ContractAssignment lifecycle TERMINAL immutability (DB parity).
--
-- The ContractAssignment state machine is trivial: ACTIVE -> ENDED, one edge. The
-- governed app path (endAssignment) already enforces transition legality with a
-- state-guarded CAS (updateMany WHERE lifecycle_state = 'ACTIVE'), and the end_reason
-- NULL-ness CHECK (migration 20260810120000) already ties ENDED to a ratified reason
-- at the DB. What was enforced ONLY in application code was the TERMINAL invariant:
-- once ENDED the assignment is closed forever -- no reopening (ENDED -> ACTIVE) and no
-- rewrite of the terminal reason. This migration adds the missing DB-level parity so a
-- raw UPDATE outside the governed repository cannot reopen or mutate a terminal row.
-- (L6-E "no hidden reopening of the source assignment" rests on this invariant.)
--
-- NULL-safety (avoids the NULL-equality first-row trap): lifecycle_state is NULLABLE
-- (BACKFILLED rows may carry none). The guard fires ONLY when OLD.lifecycle_state =
-- 'ENDED' (a non-null literal match), so it never touches a NULL/BACKFILLED row and
-- never rejects the first ACTIVE -> ENDED transition (OLD is ACTIVE there, not ENDED),
-- nor the conversion end (also ACTIVE -> ENDED with reason CONVERTED_TO_PERMANENT). The
-- change comparisons use IS DISTINCT FROM so a NULL is compared NULL-safely. Only the
-- terminal lifecycle fields are frozen -- unrelated columns and DELETE (tenant-reset)
-- are untouched.
CREATE FUNCTION placement.enforce_contract_assignment_terminal()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.lifecycle_state = 'ENDED'
     AND (NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state
          OR NEW.end_reason IS DISTINCT FROM OLD.end_reason) THEN
    RAISE EXCEPTION 'placement.ContractAssignment ENDED is terminal -- lifecycle_state and end_reason are frozen once ENDED (no reopening, no reason rewrite)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ContractAssignment_terminal_immutability"
  BEFORE UPDATE ON "placement"."ContractAssignment"
  FOR EACH ROW EXECUTE FUNCTION placement.enforce_contract_assignment_terminal();
