-- Step-5 Consent Re-Key (ADR-0016): re-key the consent ledger off the Core
-- husk onto the ATS heart. talent_id (Core talent.Talent.id) becomes
-- talent_record_id (talent_record.TalentRecord.id). PURE FORWARD DDL — the
-- ledger is empty in every seed + production path (zero rows), so there is no
-- backfill. The engagement send-gate already passes a TalentRecord.id
-- (post-#349), so the re-keyed ledger meets it with no shim.

-- Rename the ledger key column.
ALTER TABLE "consent"."TalentConsentEvent" RENAME COLUMN "talent_id" TO "talent_record_id";

-- Rename the embedded index to match the new column. The keyset index
-- (created_at,id) is declared in schema.prisma but was never migrated (only the
-- initial migration created indexes), so IF EXISTS keeps this idempotent across
-- freshly-migrated environments where that index is absent.
ALTER INDEX IF EXISTS "consent"."TalentConsentEvent_tenant_id_talent_id_occurred_at_idx"
  RENAME TO "TalentConsentEvent_tenant_id_talent_record_id_occurred_at_idx";
ALTER INDEX IF EXISTS "consent"."TalentConsentEvent_tenant_id_talent_id_created_at_id_idx"
  RENAME TO "TalentConsentEvent_tenant_id_talent_record_id_created_at_id_idx";

-- audit."ConsentAuditEvent".subject_id is UNCHANGED (the column name stays
-- subject_id and now holds a TalentRecord.id). No DDL required.
