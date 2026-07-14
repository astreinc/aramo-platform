-- TR-2b B1 (Aramo-TR2b-B1-Directive-v1_0-LOCKED Section 3 / DDR R3) — restore
-- Decision 15's L1 backfill premise PROSPECTIVELY. Add nullable structured
-- normalized-contact columns to the L1 arrival table so the future L1 writer
-- (the ADR-0019 sourcing service) can persist normalized email/phone AT
-- ARRIVAL-WRITE via the @aramo/common normalizers (normalizeEmail /
-- normalizePhone).
--
-- These are TENANT-WALLED L1 material — L1 is tenant-scoped, this is NOT
-- identity_index. They are NEVER fingerprinted at rest — fingerprinting happens
-- ONLY at admission (the canonicalization mint, gated by
-- ARAMO_IDENTITY_ADMISSION_POLICY). Raw contact values remain in `provenance`.
--
-- Nullable + additive: nothing writes to L1 yet, so ZERO rows predate these
-- columns — Decision 15's premise ("L1 retains sufficient normalized material to
-- fingerprint later") holds from this migration forward (DDR R3), and no Ruling
-- amendment is required. Values are set at INSERT only, never UPDATE'd (the
-- append-only immutability trigger from the init migration stands unchanged).

-- AlterTable
ALTER TABLE "sourced_talent"."SourcedTalent"
    ADD COLUMN "normalized_email" TEXT,
    ADD COLUMN "normalized_phone" TEXT;
