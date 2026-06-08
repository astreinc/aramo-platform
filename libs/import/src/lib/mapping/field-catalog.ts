import type { ImportTargetEntity } from '../dto/import-target-entity.js';

// PR-A8-2 — the per-target field catalog. THE Lead-review surface
// (the §2 design: are these synonym sets sensible? the field metadata
// sound?). The mapping-suggestion service consumes this catalog as its
// SoT; the import engine's REQUIRED_FIELDS (import.service.ts:150) is
// the parallel SoT for required-field flagging — both agree on the
// per-target required set.
//
// The catalog is intentionally deterministic + static (no DB, no
// network, no LLM call). It captures, per target field:
//   - type           — string | email | phone | url | date | int | money | boolean
//                      (drives the data-shape pattern picked at inference time)
//   - required       — does the import engine's REQUIRED_FIELDS list it?
//   - example        — a concrete example value shown back in the
//                      reference-doc response (so the UI can render
//                      "this field expects values like '2026-06-01'")
//   - synonyms       — normalized header strings that synonym-match
//                      this field (lowercased, alphanumeric-only). The
//                      mapping-suggestion service applies the SAME
//                      normalization to incoming CSV headers and tests
//                      for set-membership. Empty for fields the
//                      heuristic should NOT match (FK fields like
//                      company_id — system-resolved, not CSV-supplied).
//
// Synonym design rules (the Lead-review checklist):
//   1. Always include the canonical field name (normalized) as a
//      synonym so a CSV header exactly matching the field name is a
//      high-confidence hit (e.g. `email1` → 'email1').
//   2. Include common spreadsheet aliases: `firstname` / `first` / `fname`
//      / `givenname` for `first_name`; `companyname` / `organization`
//      / `employer` for company `name`.
//   3. Disambiguate phone/email variants by context: `email1` gets
//      `email`, `mail`, `primaryemail`, `workemail`; `email2` gets
//      `email2`, `alternateemail`, `personalemail`, `secondaryemail` —
//      the more-specific variants on the secondary, the generic on the
//      primary (the OpenCATS-import convention; the recruiter's csv
//      headers historically default to "Email" for the primary).
//   4. FK fields (company_id, contact_id, billing_contact_id, owner_id,
//      reports_to_id, company_department_id, recruiter_id) get EMPTY
//      synonym sets — these are system-resolved (the user picks a
//      company-id at import time, not via CSV column). The heuristic
//      will report them as `none` / `unmatched`; for REQUIRED FK
//      (contact.company_id, requisition.company_id) this is the
//      "user-must-supply-out-of-band" signal the UI surfaces.
//   5. INBOUND-VOCABULARY synonyms (the import-seam carve-out). The
//      platform's internal + UI vocabulary is `talent` — "candidate"
//      is governance-forbidden by the vocab gates as a Tier-2 anti-
//      term, NEVER displayed or stored as a field name. BUT every
//      real-world ATS export (OpenCATS / Dice / Indeed / legacy
//      systems) carries a "Candidate" / "Applicant" header — that's
//      the column a recruiter most needs the import to recognize, and
//      omitting it defeats the migration case the feature exists to
//      serve. So talent_record's identity-field synonyms accept
//      `candidate` / `candidatename` / `applicant` / `applicantname`
//      (single-column case → first_name; the existing convention is
//      that a single "name" header maps to the first identity field)
//      and `candidatefirstname` / `candidatelastname` (the explicit
//      split). These are INBOUND ALIASES ONLY — the heuristic maps
//      them into the canonical `first_name` / `last_name` target
//      fields; the stored entity, the UI label, the API response
//      never carry "candidate". `field-catalog.ts` is allowlisted in
//      `scripts/verify-vocabulary.sh` TIER2_EXCLUDES for exactly this
//      translation-purpose reason (the same pattern as the refusal-
//      enforcement scripts that legitimately list the terms they
//      enforce against). "candidate" appears in NO other target's
//      synonym set — it's a talent-only inbound alias.

export type FieldType =
  | 'string'
  | 'email'
  | 'phone'
  | 'url'
  | 'date'
  | 'int'
  | 'money'
  | 'boolean';

export interface FieldCatalogEntry {
  readonly field: string;
  readonly type: FieldType;
  readonly required: boolean;
  readonly example: string;
  readonly synonyms: readonly string[];
}

// Normalize a header (or a synonym to compare against) to the
// catalog's matching form — lowercase, ASCII alphanumeric only.
// Exported for the suggestion service + the integration spec (so the
// spec asserts the SAME normalization).
export function normalizeHeader(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// company — the OpenCATS Company shape carried into Aramo (libs/company
// CreateCompanyRequestDto). `name` is the sole required field.
const COMPANY_CATALOG: readonly FieldCatalogEntry[] = [
  {
    field: 'name',
    type: 'string',
    required: true,
    example: 'Acme Corp',
    synonyms: ['name', 'companyname', 'organization', 'org', 'employer', 'account', 'company'],
  },
  { field: 'address',         type: 'string', required: false, example: '100 Main St',     synonyms: ['address', 'addr', 'street', 'address1', 'streetaddress', 'streetname'] },
  { field: 'address2',        type: 'string', required: false, example: 'Suite 200',        synonyms: ['address2', 'addr2', 'suite', 'unit', 'apt', 'apartment', 'street2'] },
  { field: 'city',            type: 'string', required: false, example: 'Boston',           synonyms: ['city', 'town', 'locality'] },
  { field: 'state',           type: 'string', required: false, example: 'MA',               synonyms: ['state', 'province', 'region', 'stateprovince', 'st'] },
  { field: 'zip',             type: 'string', required: false, example: '02110',            synonyms: ['zip', 'zipcode', 'postal', 'postalcode', 'postcode'] },
  { field: 'phone1',          type: 'phone',  required: false, example: '+1-617-555-0100',  synonyms: ['phone1', 'phone', 'telephone', 'tel', 'mainphone', 'primaryphone'] },
  { field: 'phone2',          type: 'phone',  required: false, example: '+1-617-555-0101',  synonyms: ['phone2', 'altphone', 'alternatephone', 'secondaryphone'] },
  { field: 'fax_number',      type: 'phone',  required: false, example: '+1-617-555-0199',  synonyms: ['fax', 'faxnumber', 'faxno'] },
  { field: 'url',             type: 'url',    required: false, example: 'https://acme.com', synonyms: ['url', 'website', 'web', 'site', 'webpage', 'homepage'] },
  { field: 'key_technologies', type: 'string', required: false, example: 'TypeScript, Postgres', synonyms: ['keytechnologies', 'technologies', 'tech', 'techstack', 'stack'] },
  { field: 'notes',           type: 'string', required: false, example: 'Strategic account',  synonyms: ['notes', 'comment', 'comments', 'remarks', 'description'] },
  { field: 'is_hot',          type: 'boolean', required: false, example: 'true',             synonyms: ['ishot', 'hot', 'priority', 'vip'] },
  // FK — system-resolved; no synonyms.
  { field: 'site_id',          type: 'string', required: false, example: '<uuid>', synonyms: [] },
  { field: 'billing_contact_id', type: 'string', required: false, example: '<uuid>', synonyms: [] },
  { field: 'owner_id',         type: 'string', required: false, example: '<uuid>', synonyms: [] },
];

// contact — libs/contact CreateContactRequestDto. company_id /
// first_name / last_name are required (per import.service.ts
// REQUIRED_FIELDS).
const CONTACT_CATALOG: readonly FieldCatalogEntry[] = [
  { field: 'first_name', type: 'string', required: true, example: 'Jane',  synonyms: ['firstname', 'first', 'fname', 'givenname', 'given'] },
  { field: 'last_name',  type: 'string', required: true, example: 'Smith', synonyms: ['lastname', 'last', 'lname', 'surname', 'familyname'] },
  // FK + REQUIRED — system-resolved at import time; the user supplies
  // out-of-band. Empty synonyms so the inference reports `unmatched`,
  // which the UI surfaces as "you must pick a company".
  { field: 'company_id', type: 'string', required: true,  example: '<uuid>',          synonyms: [] },
  { field: 'title',      type: 'string', required: false, example: 'Engineering Mgr', synonyms: ['title', 'jobtitle', 'position', 'role', 'designation'] },
  { field: 'email1',     type: 'email',  required: false, example: 'jane@acme.com',   synonyms: ['email1', 'email', 'emailaddress', 'mail', 'primaryemail', 'workemail'] },
  { field: 'email2',     type: 'email',  required: false, example: 'jane@home.com',   synonyms: ['email2', 'alternateemail', 'altemail', 'personalemail', 'secondaryemail'] },
  { field: 'phone_work', type: 'phone',  required: false, example: '+1-617-555-0100', synonyms: ['phonework', 'workphone', 'officephone', 'businessphone', 'phone', 'telephone'] },
  { field: 'phone_cell', type: 'phone',  required: false, example: '+1-617-555-0101', synonyms: ['phonecell', 'cellphone', 'mobile', 'mobilephone', 'cell', 'mobilenumber'] },
  { field: 'phone_other', type: 'phone', required: false, example: '+1-617-555-0102', synonyms: ['phoneother', 'otherphone', 'homephone', 'phonehome', 'alternatephone'] },
  { field: 'address',    type: 'string', required: false, example: '100 Main St',     synonyms: ['address', 'addr', 'street', 'address1'] },
  { field: 'address2',   type: 'string', required: false, example: 'Suite 200',       synonyms: ['address2', 'addr2', 'suite', 'unit', 'apt'] },
  { field: 'city',       type: 'string', required: false, example: 'Boston',          synonyms: ['city', 'town'] },
  { field: 'state',      type: 'string', required: false, example: 'MA',              synonyms: ['state', 'province', 'region'] },
  { field: 'zip',        type: 'string', required: false, example: '02110',           synonyms: ['zip', 'zipcode', 'postal', 'postalcode'] },
  { field: 'notes',      type: 'string', required: false, example: 'Decision-maker',  synonyms: ['notes', 'comments', 'remarks'] },
  { field: 'is_hot',     type: 'boolean', required: false, example: 'true',           synonyms: ['ishot', 'hot', 'priority'] },
  { field: 'site_id',               type: 'string', required: false, example: '<uuid>', synonyms: [] },
  { field: 'company_department_id', type: 'string', required: false, example: '<uuid>', synonyms: [] },
  { field: 'reports_to_id',         type: 'string', required: false, example: '<uuid>', synonyms: [] },
  { field: 'owner_id',              type: 'string', required: false, example: '<uuid>', synonyms: [] },
];

// requisition — libs/requisition CreateRequisitionRequestDto. title +
// company_id are required.
const REQUISITION_CATALOG: readonly FieldCatalogEntry[] = [
  { field: 'title',       type: 'string', required: true,  example: 'Senior Engineer', synonyms: ['title', 'jobtitle', 'position', 'role', 'requisitiontitle', 'job'] },
  { field: 'company_id',  type: 'string', required: true,  example: '<uuid>',          synonyms: [] },
  { field: 'description', type: 'string', required: false, example: 'Build the platform...', synonyms: ['description', 'desc', 'jobdescription', 'details', 'summary'] },
  { field: 'notes',       type: 'string', required: false, example: 'Hiring-manager priority', synonyms: ['notes', 'comments'] },
  { field: 'type',        type: 'string', required: false, example: 'Full-time',       synonyms: ['type', 'jobtype', 'employmenttype', 'contracttype'] },
  { field: 'duration',    type: 'string', required: false, example: '6 months',        synonyms: ['duration', 'length', 'term', 'period'] },
  // D-AUTHZ-COMP-WRITE-2 — the deprecated rate_max/salary entries were
  // removed here. Their synonyms (pay/compensation/comp/rate/hourlyrate/
  // payrate) bypassed the compensation-edit-gate (which keys on the
  // structured fields only); the CSV path is now no longer a write
  // surface for the legacy pair. Use the structured columns (pay_rate_*,
  // bill_rate_*, salary_amount, salary_currency, placement_fee_*) instead.
  { field: 'openings',    type: 'int',    required: false, example: '3',               synonyms: ['openings', 'positions', 'headcount', 'slots', 'count'] },
  { field: 'openings_available', type: 'int', required: false, example: '2',           synonyms: ['openingsavailable', 'available', 'openpositions'] },
  { field: 'start_date',  type: 'date',   required: false, example: '2026-08-01',      synonyms: ['startdate', 'start', 'datestart', 'begindate'] },
  { field: 'city',        type: 'string', required: false, example: 'Boston',          synonyms: ['city', 'town', 'location', 'jobcity'] },
  { field: 'state',       type: 'string', required: false, example: 'MA',              synonyms: ['state', 'province'] },
  { field: 'status',      type: 'string', required: false, example: 'active',          synonyms: ['status', 'state', 'jobstatus', 'requisitionstatus'] },
  { field: 'is_hot',      type: 'boolean', required: false, example: 'true',           synonyms: ['ishot', 'hot', 'priority'] },
  { field: 'site_id',               type: 'string', required: false, example: '<uuid>', synonyms: [] },
  { field: 'contact_id',            type: 'string', required: false, example: '<uuid>', synonyms: [] },
  { field: 'company_department_id', type: 'string', required: false, example: '<uuid>', synonyms: [] },
  { field: 'recruiter_id',          type: 'string', required: false, example: '<uuid>', synonyms: [] },
  { field: 'owner_id',              type: 'string', required: false, example: '<uuid>', synonyms: [] },
];

// talent_record — libs/talent-record CreateTalentRecordRequestDto.
// first_name + last_name are required. THE non-negotiable boundary
// (A8-1 directive §0): import target_entity='talent_record' creates
// TalentRecord rows ONLY — Core talent.* rows are NEVER touched. The
// catalog only carries TalentRecord fields; no core_talent_id, no
// tier, no Portal judgment fields (R10 — Core judgment surfaces are
// not import targets).
const TALENT_RECORD_CATALOG: readonly FieldCatalogEntry[] = [
  // Inbound-vocabulary aliases (synonym design rule §5 — talent-only
  // import-seam carve-out): `candidate` / `candidatename` / `applicant`
  // / `applicantname` map a single "Candidate" / "Applicant" header
  // (the OpenCATS / Dice / Indeed / legacy-ATS convention) onto the
  // first identity field. `candidatefirstname` / `applicantfirstname`
  // handle the explicit split. NEVER displayed, NEVER stored — inbound
  // alias only.
  { field: 'first_name',   type: 'string', required: true,  example: 'Alex',            synonyms: ['firstname', 'first', 'fname', 'givenname', 'candidate', 'candidatename', 'candidatefirstname', 'applicant', 'applicantname', 'applicantfirstname'] },
  // `candidatelastname` / `applicantlastname` for the explicit split.
  // Bare `candidate` / `applicant` deliberately NOT here — a single
  // unqualified "Candidate" header maps to first_name (rule §5).
  { field: 'last_name',    type: 'string', required: true,  example: 'Reyes',           synonyms: ['lastname', 'last', 'lname', 'surname', 'candidatelastname', 'applicantlastname'] },
  { field: 'email1',       type: 'email',  required: false, example: 'alex@mail.com',   synonyms: ['email1', 'email', 'emailaddress', 'mail', 'primaryemail'] },
  { field: 'email2',       type: 'email',  required: false, example: 'alex@home.com',   synonyms: ['email2', 'alternateemail', 'altemail', 'personalemail'] },
  { field: 'phone_home',   type: 'phone',  required: false, example: '+1-617-555-0100', synonyms: ['phonehome', 'homephone', 'hometel'] },
  { field: 'phone_cell',   type: 'phone',  required: false, example: '+1-617-555-0101', synonyms: ['phonecell', 'cellphone', 'mobile', 'mobilephone', 'cell'] },
  { field: 'phone_work',   type: 'phone',  required: false, example: '+1-617-555-0102', synonyms: ['phonework', 'workphone', 'officephone', 'businessphone'] },
  { field: 'address',      type: 'string', required: false, example: '100 Main St',     synonyms: ['address', 'addr', 'street', 'address1'] },
  { field: 'address2',     type: 'string', required: false, example: 'Apt 4B',          synonyms: ['address2', 'addr2', 'suite', 'unit'] },
  { field: 'city',         type: 'string', required: false, example: 'Boston',          synonyms: ['city', 'town'] },
  { field: 'state',        type: 'string', required: false, example: 'MA',              synonyms: ['state', 'province'] },
  { field: 'zip',          type: 'string', required: false, example: '02110',           synonyms: ['zip', 'zipcode', 'postal', 'postalcode'] },
  { field: 'source',       type: 'string', required: false, example: 'referral',        synonyms: ['source', 'leadsource', 'origin', 'channel'] },
  { field: 'key_skills',   type: 'string', required: false, example: 'Go, Postgres',    synonyms: ['keyskills', 'skills', 'skillset', 'expertise', 'abilities'] },
  { field: 'current_employer', type: 'string', required: false, example: 'Globex',      synonyms: ['currentemployer', 'employer', 'currentcompany'] },
  { field: 'current_pay',  type: 'money',  required: false, example: '120000',          synonyms: ['currentpay', 'currentsalary', 'currentcomp', 'presentpay'] },
  { field: 'desired_pay',  type: 'money',  required: false, example: '140000',          synonyms: ['desiredpay', 'expectedsalary', 'desiredsalary', 'targetpay'] },
  { field: 'date_available', type: 'date', required: false, example: '2026-07-01',      synonyms: ['dateavailable', 'availability', 'availabledate'] },
  { field: 'can_relocate', type: 'boolean', required: false, example: 'true',           synonyms: ['canrelocate', 'relocate', 'willrelocate', 'relocation'] },
  { field: 'notes',        type: 'string', required: false, example: 'Strong fit',      synonyms: ['notes', 'comments', 'remarks'] },
  { field: 'web_site',     type: 'url',    required: false, example: 'https://alex.dev', synonyms: ['website', 'web', 'url', 'portfolio', 'homepage'] },
  { field: 'best_time_to_call', type: 'string', required: false, example: 'evenings',   synonyms: ['besttime', 'besttimecall', 'besttimetocontact', 'preferredtime'] },
  { field: 'is_hot',       type: 'boolean', required: false, example: 'true',           synonyms: ['ishot', 'hot', 'priority'] },
  { field: 'site_id', type: 'string', required: false, example: '<uuid>', synonyms: [] },
  { field: 'owner_id', type: 'string', required: false, example: '<uuid>', synonyms: [] },
];

export const FIELD_CATALOG: Record<ImportTargetEntity, readonly FieldCatalogEntry[]> = {
  company: COMPANY_CATALOG,
  contact: CONTACT_CATALOG,
  requisition: REQUISITION_CATALOG,
  talent_record: TALENT_RECORD_CATALOG,
};

export function getFieldCatalog(target: ImportTargetEntity): readonly FieldCatalogEntry[] {
  return FIELD_CATALOG[target];
}
