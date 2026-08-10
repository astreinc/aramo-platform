-- T8-P1 -- canonical external-requisition identity (VMS Integration Directive
-- v1.0 section 5). A VMS-originated requisition's external identity is the
-- triple (tenant_id, source_system, external_req_id). This partial UNIQUE index
-- makes that identity a DB invariant WHEN BOTH provenance fields are present, so
-- a re-imported external requisition cannot silently duplicate.
--
-- ADDITIVE and NON-DESTRUCTIVE: the predicate excludes any row with a NULL
-- source_system or NULL external_req_id, so every existing manual/non-VMS
-- requisition (both fields NULL, or only source_system tagged) stays valid and
-- unconstrained. No historical row is rewritten and no external id is
-- back-populated (directive section 5).
--
-- PARTIAL predicate: Prisma cannot express a WHERE clause on an index, so this
-- index lives in the raw migration and is documented (NOT an @@unique) in
-- schema.prisma -- mirrors the E6 Pipeline_live_episode_key precedent.
--
-- The repository translates a violation of THIS index to the exact-name code
-- REQUISITION_EXTERNAL_IDENTITY_CONFLICT (409) -- never a generic P2002 catch.

CREATE UNIQUE INDEX "Requisition_external_identity_key"
    ON "requisition"."Requisition" ("tenant_id", "source_system", "external_req_id")
    WHERE "source_system" IS NOT NULL AND "external_req_id" IS NOT NULL;
