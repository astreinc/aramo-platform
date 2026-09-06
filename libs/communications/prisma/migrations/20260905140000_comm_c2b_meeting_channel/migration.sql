-- COMM-C2B — add the provider-neutral `meeting` channel (e.g. Teams online
-- meeting). DEDICATED migration: PostgreSQL commits an ADD VALUE before the new
-- value may be used, so it must not share a transaction with any statement that
-- uses it (a later migration / insert uses it). Idempotent + additive.
ALTER TYPE "communications"."CommunicationChannel" ADD VALUE IF NOT EXISTS 'meeting';
