-- IC-1 PR-3 (restrict, immutability) — User.tenant_id can never be re-pointed
-- (Amendment A1 §1 "immutable", Invite-S2 Amendment A1, IC-0 Gate-0 §C.1 item 6 + §K gate G6b,
-- Supplement §1.4, PR-3 readiness v1.2 §11 C-2).
-- REPLAY-SAFE: CREATE OR REPLACE for the function and DROP TRIGGER IF EXISTS before CREATE
-- TRIGGER, so re-applying this file (harness and developer databases are not ledger-guarded)
-- yields exactly one trigger and no error.
-- The function body is a SINGLE-QUOTED one-line string (no dollar quoting) so the line-based
-- migration splitters in the test harness keep the statement intact: the only statement
-- terminators followed by a newline are the statement ends, and the quote-aware scanners
-- never split inside the quoted body. Separately droppable: DROP TRIGGER + DROP FUNCTION.
-- (No inline statement-terminators in these comment lines, per the comment-blind splitter guard.)

-- Function (idempotent)
CREATE OR REPLACE FUNCTION "identity".user_tenant_immutable() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id" THEN RAISE EXCEPTION ''User.tenant_id is immutable''; END IF; RETURN NEW; END';

-- Trigger (replay-safe pair; fires only on UPDATE OF tenant_id, so unrelated User updates pay nothing)
DROP TRIGGER IF EXISTS "user_tenant_no_repoint" ON "identity"."User";
CREATE TRIGGER "user_tenant_no_repoint" BEFORE UPDATE OF "tenant_id" ON "identity"."User" FOR EACH ROW EXECUTE FUNCTION "identity".user_tenant_immutable();
