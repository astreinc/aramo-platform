-- ATI-SEP-1 T10 WP5 — retire the legacy cross-product trust / identity schemas.
--
-- Directive: Aramo ATS / Talent Intelligence Separation Program v1.0 (+ Addenda
-- A1-A4; ADR-0036). Talent Intelligence (its own service + database) now owns
-- golden identity resolution, verified identifiers, global evidence, disputes
-- and trust projections; the ATS owns tenant-local identity (WP2:
-- talent_duplicate_advisory, talent_record_sourced_arrival,
-- RawPayloadReference.sourced_talent_id). libs/talent-trust, libs/platform-trust
-- and libs/identity-index are deleted from the codebase, so their schemas are
-- dropped here.
--
-- CLEAN REBUILD — DATA IS NOT MIGRATED. Every row in these schemas is discarded
-- (trust subjects / evidence ledger / anchors / verification requests /
-- proposals / disputes, dormant links, person clusters + fingerprints).
-- Surviving soft references stay INERT (ADD-not-rename; no FK ever crossed a
-- schema): TalentRecord.cluster_id, RawPayloadReference.resolved_subject_id /
-- resolved_cluster_id, PortalUser.cluster_id (Addendum A4 — no destructive
-- portal_identity migration), consent."TalentErasureRun".subject_ids.
--
-- The S2 talent-write guard trigger that consent migration
-- 20261016190000_s2_erasure_write_serialization attached to
-- talent_trust."VerificationRequest" is dropped WITH that table (CASCADE); that
-- migration's trigger loop is to_regclass-guarded, so a fresh-DB replay (where
-- these schemas never exist) applies cleanly. IF EXISTS keeps a re-run and a
-- fresh DB a no-op.
--
-- PRODUCTION: applying this migration to PROD requires SEPARATE, explicit PO
-- authorization (destructive, irreversible). It must not ride a routine deploy;
-- take a pre-apply backup.

DROP SCHEMA IF EXISTS talent_trust CASCADE;
DROP SCHEMA IF EXISTS platform_trust CASCADE;
DROP SCHEMA IF EXISTS identity_index CASCADE;
