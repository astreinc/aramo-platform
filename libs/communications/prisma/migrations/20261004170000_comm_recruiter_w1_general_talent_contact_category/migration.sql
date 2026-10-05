-- COMM-RECRUITER-W1 (W1-A1) — add the General Talent Contact email-template
-- category (Talent-only, no requisition). DEDICATED migration: PostgreSQL commits
-- an ADD VALUE before the new value may be used, so it must not share a
-- transaction with any statement that uses it. Idempotent + additive. No backfill
-- (the code-owned default system.talent-general-contact.v1 is the fallback when a
-- tenant has no override row).
ALTER TYPE "communications"."EmailTemplateCategory" ADD VALUE IF NOT EXISTS 'talent_general_contact';
