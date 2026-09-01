-- HF-AUTH-1 — AuthorizationVersion. The monotonic per-(tenant, principal)
-- authorization-revision authority. The compact access JWT references the
-- version it was minted at, and the guard forces re-resolve/refresh on a
-- mismatch, so a revoked grant cannot survive on an already-issued token.
-- Postgres is the authority. Redis only caches the resolved snapshot keyed by
-- this version. (No inline statement-terminators in these comment lines, per
-- the comment-blind splitter guard.)
CREATE TABLE "identity"."AuthorizationVersion" (
  "id"           UUID         NOT NULL,
  "tenant_id"    UUID         NOT NULL,
  "principal_id" UUID         NOT NULL,
  "version"      INTEGER      NOT NULL DEFAULT 1,
  "updated_at"   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT "AuthorizationVersion_pkey" PRIMARY KEY ("id")
);

-- One version row per (tenant, principal) — the upsert target for bumps.
CREATE UNIQUE INDEX "AuthorizationVersion_tenant_id_principal_id_key"
  ON "identity"."AuthorizationVersion" ("tenant_id", "principal_id");

CREATE INDEX "AuthorizationVersion_tenant_id_idx"
  ON "identity"."AuthorizationVersion" ("tenant_id");
