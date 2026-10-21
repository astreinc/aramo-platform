-- Talent Lifecycle R1–R5 Implementation Directive v1.2 LOCKED §7.4 (S4, LR L-6 REVISED) — none of
-- the existing dispositions means "recruiter-confirmed relevant response" (`connected` is a
-- connection outcome; `interested` is a Talent sentiment). Additive enum value; existing rows are
-- untouched. Its own migration: a new enum value cannot be used in the transaction that adds it.
ALTER TYPE "communications"."CommunicationDispositionOutcome" ADD VALUE IF NOT EXISTS 'response_confirmed';
