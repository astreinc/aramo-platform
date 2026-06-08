// R6' — contact mutate types. Hand-mirrored from libs/contact/src/lib/
// dto/{create-contact-request,update-contact-request}.dto.ts +
// libs/contact/src/lib/dto/contact.view.ts (the ContactView already
// lives in ../companies/types.ts — R3 wired it there because the R3
// company-detail surfaces contacts as a panel; R6' re-uses that
// canonical hand-mirror rather than diverging it). Source-annotated:
// a future BE DTO change is caught at build time (missing field), NOT
// runtime drift. Flat-fields hand-mirror — no drift spec (rule of
// three: that pattern is for mirrored LOGIC, not flat DTO field lists).
//
// Tiered fields (ruling A): first/last/title/email1/2/phone_work
// inline; address block / phone_cell / phone_other / is_hot / notes
// behind a "More fields" disclosure.
//
// company_id is REQUIRED on CREATE (every contact belongs to a
// company); the route encodes it in the URL (R6' /companies/:companyId/
// contacts/new). It is structurally absent from UpdateContactRequest
// — a contact's company anchor cannot change (same pattern as R5's
// core_talent_id-locked-out PATCH DTO).
//
// reports_to_id (the self-link): the BE has ZERO validation here. The
// FE owns: (a) picker source = the company's contacts, (b) exclude-
// self on EDIT (a contact can't report to itself), (c) same-company
// is naturally enforced by the picker source. Circular chains
// (A->B->C->A) are out of scope for R6' — UX-only, no safety stake.
//
// company_department_id (ruling D): the DTO accepts it but R6' does
// NOT surface a picker. On PATCH the field is PRESERVED via
// omit-not-touch (we never send the key — the BE leaves it untouched).
// A future department-management UI lands the picker.
//
// owner_id (ruling F): omitted from the form (no /v1/users:assignable
// endpoint). Server defaults to entered_by_id.

export interface CreateContactRequest {
  readonly company_id: string;
  readonly first_name: string;
  readonly last_name: string;
  readonly title?: string;
  readonly email1?: string;
  readonly email2?: string;
  readonly phone_work?: string;
  readonly phone_cell?: string;
  readonly phone_other?: string;
  readonly address?: string;
  readonly address2?: string;
  readonly city?: string;
  readonly state?: string;
  readonly zip?: string;
  readonly is_hot?: boolean;
  readonly notes?: string;
  readonly reports_to_id?: string;
}

// PATCH semantics: omit=unchanged; null=clear. first_name/last_name
// are PATCHable as `string` only (required fields stay required —
// can't be nulled). company_id is structurally absent (anchor stays
// fixed). left_company is PATCH-only — surfaced on EDIT (ruling C).
export interface UpdateContactRequest {
  readonly first_name?: string;
  readonly last_name?: string;
  readonly title?: string | null;
  readonly email1?: string | null;
  readonly email2?: string | null;
  readonly phone_work?: string | null;
  readonly phone_cell?: string | null;
  readonly phone_other?: string | null;
  readonly address?: string | null;
  readonly address2?: string | null;
  readonly city?: string | null;
  readonly state?: string | null;
  readonly zip?: string | null;
  readonly is_hot?: boolean;
  readonly notes?: string | null;
  readonly left_company?: boolean;
  readonly reports_to_id?: string | null;
}
