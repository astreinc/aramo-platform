-- Track 4 / T4-C -- the ratified ending-reason taxonomy. ADDITIVE.
--
-- An ENDED ContractAssignment must authoritatively distinguish the ratified
-- business categories -- normal completion, worker-ended, employer/client-ended --
-- as a CLOSED enum, never an undifferentiated free-text reason. Provenance-conditional
-- like the lifecycle state: ENDED rows require an end_reason, ACTIVE rows carry none.
--
-- CREATE TYPE (new enum) + ADD COLUMN of that type is safe in one migration -- the
-- enum-add-then-use restriction only applies to ALTER TYPE ADD VALUE on an existing
-- enum used in the same transaction. 'ENDED' referenced in the CHECK was added by the
-- prior committed migration 20260810100000.
--
-- NOTE keep every line comment free of the statement terminator and dollar-quote.

CREATE TYPE "placement"."ContractAssignmentEndReason" AS ENUM ('COMPLETED', 'WORKER_ENDED', 'CLIENT_ENDED');

ALTER TABLE "placement"."ContractAssignment"
  ADD COLUMN "end_reason" "placement"."ContractAssignmentEndReason";

-- An ENDED assignment MUST carry a ratified end reason -- an ACTIVE (or any
-- non-ended) assignment must NOT. This keeps the three business categories
-- structurally distinct in the substrate, not in free text.
ALTER TABLE "placement"."ContractAssignment"
  ADD CONSTRAINT "ContractAssignment_end_reason_matches_state_chk"
  CHECK (("lifecycle_state" = 'ENDED') = ("end_reason" IS NOT NULL));
