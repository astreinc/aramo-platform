// PR-A8-4 — outbound field catalog.
//
// The OUTBOUND mirror of `libs/import/src/lib/mapping/field-catalog.ts`
// (the inbound mapping catalog). Two boundaries set this catalog apart
// from the inbound one — both are load-bearing for the Lead review:
//
//   1. R10 (the structural seam). Every column listed here is an ATS
//      schema column (company / contact / requisition / talent_record /
//      pipeline). NO Core-judgment column appears (the R10-forbidden
//      set; refer to scripts/verify-vocabulary.sh + ci/scripts/
//      verify-ats-refusal.ts for the authoritative enumeration). The
//      ATS entity schemas structurally hold no Core-judgment field
//      (the Gate-5 §1 check confirmed this); the export consequently
//      CAN'T leak any of those — there is nothing to leak. The
//      lint:nx-boundaries graph records ZERO Core/engagement/submittal/
//      examination/talent/job_domain edges from libs/export — the
//      structural proof.
//
//   2. The OUTBOUND-VOCABULARY rule (export speaks Talent). The
//      inbound catalog at libs/import deliberately accepts certain
//      legacy-ATS-export aliases as synonyms in the talent_record
//      target — the migration-case carve-out (the inbound carve-out
//      is documented in libs/import field-catalog). Export is the
//      OTHER direction: the headers a recruiter downloads are the
//      canonical Aramo field names (first_name, last_name, email1,
//      etc.). The outbound surface is the product's own vocabulary;
//      the inbound carve-out is import-only. The integration spec
//      asserts the talent_record export header row contains the
//      canonical field names and zero outbound-anti-tokens
//      (vocab-clean outbound).
//
// Columns enumerated per entity:
//   - Every ATS-schema column EXCEPT `tenant_id` (implicit — the JWT
//     defines the tenant; including it on every row adds zero value
//     and is confusing when the export is shared across tenant lines).
//   - `id`, `site_id`, `created_at`, `updated_at` are included
//     (operationally useful: id for downstream linking; timestamps
//     for date-range filtering by the consumer).
//   - `import_batch_id` is INTENTIONALLY EXCLUDED — it lives in the
//     ATS schemas (PR-A8-1 back-reference) but is NOT projected by
//     the entity View DTOs (CompanyView / ContactView / etc.). The
//     View DTO is the documented external read-surface; the export
//     contract follows it. (An internal-provenance column for the
//     import engine's revert path; recruiter-facing exports don't
//     carry it.)
//   - talent_record carries `core_talent_id` — this is an ATS-schema
//     column (the cross-schema logical UUID ref to talent.Talent.id,
//     Architecture §7.3), NOT a Core-judgment field. R10 forbids
//     the Core-judgment column set (see refusal-check); an opaque
//     foreign-key UUID to Core is structurally indistinguishable
//     from any other UUID column and carries no judgment, so it is
//     exportable.
//
// The catalog is the single source of truth for the column-selection
// validator at the controller (§2 design: an unknown column → 400
// VALIDATION_ERROR).

export type ExportEntityType =
  | 'company'
  | 'contact'
  | 'requisition'
  | 'talent_record'
  | 'pipeline';

export const EXPORT_ENTITY_TYPES: readonly ExportEntityType[] = [
  'company',
  'contact',
  'requisition',
  'talent_record',
  'pipeline',
];

// Each entry is a column name that appears in the exported CSV's
// header row and as a key in the per-row record passed to the CSV
// stringifier. Names are the canonical Aramo ATS field names — no
// outbound-anti-tokens (R12 / the outbound-vocabulary rule).

const COMPANY_COLUMNS: readonly string[] = [
  'id',
  'site_id',
  'name',
  'address',
  'address2',
  'city',
  'state',
  'zip',
  'phone1',
  'phone2',
  'fax_number',
  'url',
  'key_technologies',
  'notes',
  'is_hot',
  'billing_contact_id',
  'owner_id',
  'entered_by_id',
  'created_at',
  'updated_at',
];

const CONTACT_COLUMNS: readonly string[] = [
  'id',
  'site_id',
  'company_id',
  'company_department_id',
  'first_name',
  'last_name',
  'title',
  'email1',
  'email2',
  'phone_work',
  'phone_cell',
  'phone_other',
  'address',
  'address2',
  'city',
  'state',
  'zip',
  'is_hot',
  'notes',
  'left_company',
  'reports_to_id',
  'owner_id',
  'entered_by_id',
  'created_at',
  'updated_at',
];

const REQUISITION_COLUMNS: readonly string[] = [
  'id',
  'site_id',
  'title',
  'company_id',
  'contact_id',
  'company_department_id',
  'status',
  'type',
  'duration',
  'rate_max',
  'salary',
  'description',
  'notes',
  'is_hot',
  'openings',
  'openings_available',
  'start_date',
  'city',
  'state',
  'recruiter_id',
  'owner_id',
  'entered_by_id',
  'created_at',
  'updated_at',
];

// talent_record — the OUTBOUND surface speaks Talent. The header row
// emits these canonical field names verbatim — no inbound-vocabulary
// alias appears outbound.
const TALENT_RECORD_COLUMNS: readonly string[] = [
  'id',
  'site_id',
  'first_name',
  'last_name',
  'email1',
  'email2',
  'phone_home',
  'phone_cell',
  'phone_work',
  'address',
  'address2',
  'city',
  'state',
  'zip',
  'source',
  'key_skills',
  'current_employer',
  'current_pay',
  'desired_pay',
  'date_available',
  'can_relocate',
  'is_hot',
  'notes',
  'web_site',
  'best_time_to_call',
  'owner_id',
  'entered_by_id',
  // PR-A5b-2 — the Core-Talent link (cross-schema logical UUID ref;
  // an OPAQUE FK, not a Core-judgment field — R10-safe).
  'core_talent_id',
  'created_at',
  'updated_at',
];

const PIPELINE_COLUMNS: readonly string[] = [
  'id',
  'site_id',
  'talent_record_id',
  'requisition_id',
  'status',
  'created_at',
  'updated_at',
];

const CATALOG: Record<ExportEntityType, readonly string[]> = {
  company: COMPANY_COLUMNS,
  contact: CONTACT_COLUMNS,
  requisition: REQUISITION_COLUMNS,
  talent_record: TALENT_RECORD_COLUMNS,
  pipeline: PIPELINE_COLUMNS,
};

export function getDefaultColumns(entity: ExportEntityType): readonly string[] {
  return CATALOG[entity];
}

export function isExportableColumn(
  entity: ExportEntityType,
  column: string,
): boolean {
  return CATALOG[entity].includes(column);
}

// Resolve the effective column list. `requested` is the optional
// comma-separated list parsed by the controller. Returns either the
// vetted subset (preserving caller order) or null when ANY requested
// column is not in the entity's catalog — the controller turns null
// into 400 VALIDATION_ERROR.
export function resolveColumns(
  entity: ExportEntityType,
  requested: readonly string[] | undefined,
): readonly string[] | null {
  if (requested === undefined || requested.length === 0) {
    return CATALOG[entity];
  }
  for (const c of requested) {
    if (!CATALOG[entity].includes(c)) return null;
  }
  return requested;
}
