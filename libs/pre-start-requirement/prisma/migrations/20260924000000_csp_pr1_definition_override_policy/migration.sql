-- Pre-Start Requirement -- CSP PR-1 (Client-Scoped Business Policy directive, section D4-A).
--
-- override_policy governs whether a MORE-SPECIFIC scope (CLIENT/REQUISITION) may relax a
-- requirement inherited from a broader layer. DEFAULT: overridable freely. FLOOR: a non-
-- relaxable floor -- a more-specific layer may only STRENGTHEN it, never weaken it, across
-- the strictness-bearing dimensions blocking, waiver_mode, satisfaction_policy (see
-- floor-strictness.ts). Default DEFAULT -- existing definitions keep today's fully
-- overridable behaviour.
--
-- Definition-level ONLY. The floor is enforced during the layered merge (resolveEffective,
-- authoritative fail-closed) and at publish time. The materialized Instance snapshot carries
-- the already-floor-validated effective blocking/waiver/satisfaction values, so it needs no
-- override_policy column and the frozen-column immutability trigger is unchanged.
--
-- NOTE keep every line comment free of the statement terminator and of the dollar-quote
-- delimiter -- the integration migration splitter is dollar-quote aware but does not strip
-- line comments.

ALTER TABLE "pre_start_requirement"."PreStartRequirementDefinition"
  ADD COLUMN "override_policy" TEXT NOT NULL DEFAULT 'DEFAULT';
