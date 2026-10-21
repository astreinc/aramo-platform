// RTR template binding failures → the SPECIFIC missing fact and where to fix it.
// The API names the unresolved binding in details.binding_key (fail-closed —
// Aramo never substitutes a value); the old copy always blamed "the requisition
// reference", which sent recruiters to the wrong place (e.g. when the tenant's
// legal name was the gap). Unknown keys fall back to a neutral message.

const BINDING_MESSAGES: Readonly<Record<string, string>> = {
  'recruiting_company.name':
    'Your organization’s legal name isn’t set. Ask an admin to add it in Settings → Tenant profile, then try again.',
  'client.name':
    'This requisition has no client company. Add the client on the requisition, then try again.',
  'requisition.title': 'This requisition has no title. Add one on the requisition, then try again.',
  'requisition.reference': 'This requisition has no reference number yet. Save the requisition, then try again.',
  'requisition.description':
    'This requisition has no job description. Add one on the requisition, then try again.',
  'talent.full_name':
    'This talent’s first or last name is missing. Complete it on the talent profile, then try again.',
  'talent.desired_pay_rate':
    'This talent has no desired pay rate on record. Add it on the talent profile, then try again.',
  'recruiter.display_name':
    'Your user profile has no display name. Add it to your profile, then try again.',
};

const GENERIC =
  'This RTR can’t be prepared yet — a detail the approved template needs is missing. Ask an admin to check the template’s fields.';

const TEMPLATE_NOT_READY =
  'Your workspace has not approved a Right to Represent template yet. Ask an admin to approve one in Settings → Documents.';

// DOC-TEMPLATE-LIB-1 T-6 (§9) — the Aramo default was withdrawn and no own template exists.
const TEMPLATE_SELECTION_REQUIRED =
  'The Aramo Right to Represent template your workspace used has been withdrawn. Ask an admin to choose a template for your organization.';

interface ErrLike {
  readonly code?: string;
  readonly details?: Record<string, unknown>;
}

// null when the error isn't an RTR template/binding refusal.
export function rtrTemplateErrorMessage(e: unknown): string | null {
  const err = (e ?? {}) as ErrLike;
  const code = err.code;
  if (code === 'RTR_TEMPLATE_NOT_CONFIGURED' || code === 'RTR_TEMPLATE_CONFIGURATION_INVALID') return TEMPLATE_NOT_READY;
  if (code === 'TEMPLATE_SELECTION_REQUIRED') return TEMPLATE_SELECTION_REQUIRED;
  if (code === 'RTR_TEMPLATE_BINDING_MISSING' || code === 'TEMPLATE_BINDING_UNSUPPORTED') {
    const key = typeof err.details?.['binding_key'] === 'string' ? (err.details['binding_key'] as string) : null;
    if (err.details?.['reason'] === 'binding_resolver_missing' || err.details?.['reason'] === 'unknown_binding') return GENERIC;
    return (key !== null ? BINDING_MESSAGES[key] : undefined) ?? GENERIC;
  }
  return null;
}
