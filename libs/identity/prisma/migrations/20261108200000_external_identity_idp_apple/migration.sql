-- Aramo Sign Apple Platform Go-Live Directive v1.0 (LOCKED) W1 / R-1 — `apple`
-- (Cognito provider SignInWithApple) becomes a recorded federated provider.
-- Widens the ExternalIdentityIdp provider CHECK from ('google', 'microsoft') to
-- ('google', 'microsoft', 'apple'). No column, table or returned shape changes,
-- and every existing row already satisfies the wider CHECK.
-- Lock risk: the DROP and ADD take a brief ACCESS EXCLUSIVE lock on a small table
-- while the new CHECK validates the existing rows.
-- REPLAY-SAFE: DROP CONSTRAINT IF EXISTS, then ADD.
-- splitDdl-safe: no semicolons in comment lines.

ALTER TABLE "identity"."ExternalIdentityIdp" DROP CONSTRAINT IF EXISTS "ExternalIdentityIdp_idp_check";

ALTER TABLE "identity"."ExternalIdentityIdp" ADD CONSTRAINT "ExternalIdentityIdp_idp_check" CHECK ("idp" IN ('google', 'microsoft', 'apple'));
