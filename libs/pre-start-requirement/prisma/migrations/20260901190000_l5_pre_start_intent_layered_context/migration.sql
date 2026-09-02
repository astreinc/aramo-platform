-- Pre-Start Requirement -- Lane 5 / L5-P5 -- layered materialization context.
--
-- Ruling P2: onboarding config is layered TENANT -> CLIENT/ACCOUNT -> REQUISITION.
-- The reconciler re-resolves the precedence chain from the durable intent, so the
-- intent captures the layered refs at intake. Both columns are ADDITIVE + NULLABLE
-- (a TENANT-only placement leaves both NULL, resolving the tenant baseline alone).
-- PreStartMaterializationIntent is MUTABLE by design -- no immutability trigger.
--
-- NOTE keep every line comment free of the statement terminator and of the
-- dollar-quote delimiter -- the integration migration splitter is dollar-quote aware
-- but does not strip line comments.
ALTER TABLE "pre_start_requirement"."PreStartMaterializationIntent"
  ADD COLUMN "client_id" UUID,
  ADD COLUMN "requisition_id" UUID;
