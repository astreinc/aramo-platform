// Closed enum mirror of openapi/common.yaml ContactChannel schema (PR-3.2).
// The OpenAPI schema is the source of truth; this TypeScript representation
// is the program-side mirror used in DTOs and resolver code. Values must
// stay in sync with the OpenAPI schema; adding a value requires Architect
// approval per doc/02-claude-code-discipline.md Rule 4.
//
// ContactChannel is a dimension within the contacting consent scope, not a
// separate scope. PR-4 consumes it in the /consent/check request body for
// channel constraint validation.

export const CONTACT_CHANNELS = [
  'email',
  'phone',
  'sms',
  'indeed',
  'portal',
  'other',
] as const;

export type ContactChannel = (typeof CONTACT_CHANNELS)[number];
