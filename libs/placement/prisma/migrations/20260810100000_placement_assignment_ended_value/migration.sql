-- Track 4 / T4-C -- ContractAssignment lifecycle: add the ENDED state. ADDITIVE.
--
-- SEPARATE migration from the guard that USES it (20260810110000): a newly added
-- enum value cannot be used in the same transaction that adds it, and prisma
-- migrate deploy runs each migration file in one transaction. Adding the value
-- alone here, then using it in the next migration, is the production-safe split.
--
-- NOTE keep every line comment free of the statement terminator and dollar-quote.

ALTER TYPE "placement"."ContractAssignmentState" ADD VALUE IF NOT EXISTS 'ENDED';
