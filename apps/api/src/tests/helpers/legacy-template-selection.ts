// ORG-UX-1 (Directive v1.0 LOCKED §5.3, P2 T-A) — test helper: give a tenant a
// GRANDFATHERED (legacy_platform) tenant-wide selection of an Aramo (PLATFORM) default,
// exactly as the 20261022130000 migration writes one for a tenant that relied on the
// default before the gallery-first rule. Specs that exercise "a tenant on the Aramo default"
// (branding at render, withdrawal, Sign library) use it; a tenant created without it has
// no fallback (SELECTION_REQUIRED). Raw SQL: the repository refuses new PLATFORM selections.
import { randomUUID } from 'node:crypto';

const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';

export async function grantLegacyPlatformSelection(
  query: (sql: string, params: unknown[]) => Promise<unknown>,
  args: { tenant_id: string; document_type_id: string; template_id: string; client_id?: string | null },
): Promise<void> {
  await query(
    `INSERT INTO "documents"."TenantTemplateSelection"
       ("id", "tenant_id", "document_type_id", "client_id", "template_id", "selected_by", "updated_at", "legacy_platform")
     VALUES ($1, $2, $3, $4, $5, $6, now(), true)
     ON CONFLICT ("tenant_id", "document_type_id", "client_id")
     DO UPDATE SET "template_id" = EXCLUDED."template_id", "legacy_platform" = true, "updated_at" = now()`,
    [randomUUID(), args.tenant_id, args.document_type_id, args.client_id ?? null, args.template_id, SYSTEM_ACTOR],
  );
}
