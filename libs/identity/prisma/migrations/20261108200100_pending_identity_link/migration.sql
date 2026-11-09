-- Aramo Sign Apple Platform Go-Live Amendment A1 (LOCKED) L-2 / L-4 / L-8 — the
-- pending identity link. A hosted-UI or native sign-in that holds a valid token
-- for a known federated provider but is denied (user_not_provisioned or
-- idp_identity_conflict) writes one row. Nothing is linked and no session is
-- issued at that point. The row is consumed once the user proves an existing
-- account (provider sign-in, an emailed code, or a signed-in session).
-- ADDITIVE ONLY: one new table and its indexes. No existing column or returned
-- shape changes.
--
--   handle_hash          sha256 base64url of the random 32-byte handle (the handle
--                        itself is never stored)
--   provider, provider_subject, idp, email_snapshot
--                        the denied identity (email_snapshot is the same value
--                        ExternalIdentity already keeps, no other PII)
--   matched_user_id      the conflict case only (the user whose email matched)
--   code_*               the email-code proof (L-4 b): SHA-256 of the code, its
--                        expiry, attempts, the account it was sent to, the last
--                        send time and the send count
-- Expired rows are deleted on each write (expires_at < now() - 1 day).
-- REPLAY-SAFE: IF NOT EXISTS everywhere.
-- splitDdl-safe: no semicolons in comment lines.

CREATE TABLE IF NOT EXISTS "identity"."PendingIdentityLink" (
    "id" UUID NOT NULL,
    "handle_hash" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_subject" TEXT NOT NULL,
    "idp" TEXT NOT NULL,
    "email_snapshot" TEXT,
    "reason" TEXT NOT NULL,
    "matched_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "code_hash" TEXT,
    "code_expires_at" TIMESTAMPTZ(6),
    "code_attempts" INTEGER NOT NULL DEFAULT 0,
    "code_target_user_id" UUID,
    "code_last_sent_at" TIMESTAMPTZ(6),
    "code_send_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PendingIdentityLink_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PendingIdentityLink_idp_check" CHECK ("idp" IN ('google', 'microsoft', 'apple')),
    CONSTRAINT "PendingIdentityLink_reason_check" CHECK ("reason" IN ('user_not_provisioned', 'idp_identity_conflict'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "PendingIdentityLink_handle_hash_key" ON "identity"."PendingIdentityLink"("handle_hash");

CREATE INDEX IF NOT EXISTS "PendingIdentityLink_expires_at_idx" ON "identity"."PendingIdentityLink"("expires_at");

CREATE INDEX IF NOT EXISTS "PendingIdentityLink_code_target_user_id_idx" ON "identity"."PendingIdentityLink"("code_target_user_id");
