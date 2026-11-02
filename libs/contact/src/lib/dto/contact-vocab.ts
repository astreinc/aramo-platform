// Contact-spec amendment v1.0 (LOCKED) — closed vocabularies for the two
// categorical Contact fields. String + application-layer validation (the
// platform convention — NO Prisma enum; cf. company status/client_tier which
// are likewise String-not-enum). These arrays ARE the @IsIn set; the write
// path (create/update) rejects out-of-vocab values with VALIDATION_ERROR.

import { AramoError } from '@aramo/common';

// relationship_role — the contact's categorical FUNCTION in the account.
// R10-safe: a category, NEVER an ordinal/quality rating of the person.
export const RELATIONSHIP_ROLE_VALUES = [
  'decision_maker',
  'hiring_manager',
  'champion',
  'influencer',
  'gatekeeper',
  'billing_contact',
] as const;
export type RelationshipRole = (typeof RELATIONSHIP_ROLE_VALUES)[number];

// preference — contact contactability. Distinct from the talent-consent moat;
// this is a CRM preference stored on the Contact row. null displays as
// contactable but stores null (no fabricated grant).
export const PREFERENCE_VALUES = [
  'contactable',
  'limited',
  'do_not_contact',
] as const;
export type ContactPreference = (typeof PREFERENCE_VALUES)[number];

// CONTACTS-1 §12 — contact_kind. A person, or a functional mailbox such as
// "Accounts Payable". null = unclassified. Also CHECK-constrained in the DB.
export const CONTACT_KIND_VALUES = ['PERSON', 'FUNCTIONAL_MAILBOX'] as const;
export type ContactKind = (typeof CONTACT_KIND_VALUES)[number];

// Write-path vocab guard. Mirrors the @IsIn contract at the app layer:
// undefined → skip (omit-not-touch on PATCH); null → allowed (clears the
// field); any other value MUST be in the closed set or 400 VALIDATION_ERROR
// with details.field (so the FE error-mapping surfaces which field is bad).
export function assertContactVocab(
  input: {
    relationship_role?: string | null;
    preference?: string | null;
    contact_kind?: string | null;
  },
  requestId: string,
): void {
  const check = (
    field: 'relationship_role' | 'preference' | 'contact_kind',
    value: string | null | undefined,
    allowed: readonly string[],
  ): void => {
    if (value === undefined || value === null) return;
    if (!allowed.includes(value)) {
      throw new AramoError(
        'VALIDATION_ERROR',
        `${field} must be one of: ${allowed.join(', ')}`,
        400,
        { requestId, details: { field, allowed: [...allowed] } },
      );
    }
  };
  check('relationship_role', input.relationship_role, RELATIONSHIP_ROLE_VALUES);
  check('preference', input.preference, PREFERENCE_VALUES);
  check('contact_kind', input.contact_kind, CONTACT_KIND_VALUES);
}
