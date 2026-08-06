-- Track 3 / E3 — governed terminal/fallthrough reason evidence on the placement
-- event log. ADDITIVE ONLY: the generated init migration and the lifecycle
-- registry are NOT touched, so placement:sql:check (which owns only the init
-- migration) stays byte-equal. No new table, no new tenant-reset target -- the
-- reason evidence is columns on PlacementProcessEvent and is deleted with the row.
--
-- NOTE keep every line comment free of the statement terminator and of the
-- dollar-quote delimiter -- the integration migration splitter is dollar-quote
-- aware but does not strip line comments.
--
-- Nullable by design: present only for a transition into a governed terminal
-- state, null for every non-governed transition and for all legacy pre-E3 rows.
-- No backfill -- legacy absence stays null and is never fabricated into a reason.

ALTER TABLE "placement"."PlacementProcessEvent"
  ADD COLUMN "reason_code" TEXT,
  ADD COLUMN "reason_label_snapshot" TEXT,
  ADD COLUMN "reason_detail" TEXT;

-- Structural invariants enforceable safely at the database (registry membership,
-- target-state compatibility, and detail policy remain application-enforced since
-- the registry is code-backed). A code and its label snapshot always travel
-- together, and detail may exist only alongside a code.
ALTER TABLE "placement"."PlacementProcessEvent"
  ADD CONSTRAINT "PlacementProcessEvent_reason_code_label_paired_chk"
  CHECK (("reason_code" IS NULL) = ("reason_label_snapshot" IS NULL));

ALTER TABLE "placement"."PlacementProcessEvent"
  ADD CONSTRAINT "PlacementProcessEvent_reason_detail_requires_code_chk"
  CHECK ("reason_detail" IS NULL OR "reason_code" IS NOT NULL);
