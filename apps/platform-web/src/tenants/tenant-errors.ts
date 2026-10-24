import { ApiError } from '@aramo/fe-foundation';

import { tenantStatusPill } from '../components';

// PLATFORM-UX-1 F-4/F-5 — error → copy mapping for the tenant screens (handoff
// §6.2, §6.3, §7; amendment 4). Every message is plain copy plus the mono code;
// a server message is shown as written only where the design says so
// (VALIDATION_ERROR on the user invite carries refused role combinations).

export interface ErrorCopy {
  /** The plain sentence. */
  readonly message: string;
  /** The code shown in mono after it. */
  readonly code: string;
}

export type ProvisionField = 'name' | 'email' | 'slug';

export type ProvisionErrorCopy =
  | ({ readonly kind: 'form'; readonly step: 1 | 3 } & ErrorCopy)
  | { readonly kind: 'field'; readonly field: ProvisionField; readonly message: string };

const GENERIC = 'Something went wrong. Try again in a minute.';

function reasonOf(e: ApiError): string | undefined {
  const r = e.details?.['reason'];
  return typeof r === 'string' ? r : undefined;
}

/** POST /platform/tenants failure → the copy and where it shows (handoff §6.2). */
export function provisionErrorCopy(err: unknown): ProvisionErrorCopy {
  if (!(err instanceof ApiError)) return { kind: 'form', step: 3, message: GENERIC, code: 'NETWORK_ERROR' };
  const code = err.code ?? `HTTP_${err.status}`;
  if (code === 'TENANT_ALREADY_EXISTS') {
    return {
      kind: 'form',
      step: 1,
      code,
      message: 'A tenant with this name or slug already exists. Choose a different name or slug.',
    };
  }
  if (code === 'EMAIL_UNAVAILABLE') {
    return {
      kind: 'form',
      step: 1,
      code,
      message:
        'This email already belongs to another organization. One person can belong to only one organization, so use a different owner email.',
    };
  }
  if (code === 'COGNITO_PROVISION_FAILED') {
    return {
      kind: 'form',
      step: 3,
      code,
      message:
        'We couldn’t create the owner’s sign-in account. Nothing was saved. Try again in a minute; if it keeps failing, contact platform engineering.',
    };
  }
  if (code === 'VALIDATION_ERROR') {
    const reason = reasonOf(err);
    if (reason === 'invalid_slug') return { kind: 'field', field: 'slug', message: 'Use lowercase letters, numbers and hyphens.' };
    if (reason === 'reserved_slug') return { kind: 'field', field: 'slug', message: 'This address is reserved. Choose a different slug.' };
    if (reason === 'invalid_owner_email') return { kind: 'field', field: 'email', message: 'Enter a valid email address.' };
    return { kind: 'form', step: 1, code: reason ?? code, message: err.message || 'Check the highlighted fields.' };
  }
  return { kind: 'form', step: 3, code, message: err.message || GENERIC };
}

/** POST /platform/tenants/:id/invitations failure → copy (amendment 4). */
export function inviteErrorCopy(err: unknown): ErrorCopy {
  if (!(err instanceof ApiError)) return { message: GENERIC, code: 'NETWORK_ERROR' };
  const code = err.code ?? `HTTP_${err.status}`;
  if (code === 'INVITATION_ALREADY_EXISTS') {
    return { code, message: 'This person already has a pending invitation to this tenant.' };
  }
  if (code === 'EMAIL_UNAVAILABLE') {
    return { code, message: 'This email belongs to another organization. One person can belong to only one organization.' };
  }
  // VALIDATION_ERROR includes refused role combinations: show the server message.
  if (code === 'VALIDATION_ERROR') return { code, message: err.message || 'Check the email and roles.' };
  return { code, message: err.message || GENERIC };
}

const statusWord = (status: string): string => tenantStatusPill(status).label;

/** A lifecycle transition failure → copy (handoff §7). `current` is the status the dialog opened on. */
export function lifecycleErrorCopy(err: unknown, current: string): ErrorCopy {
  if (!(err instanceof ApiError)) return { message: GENERIC, code: 'NETWORK_ERROR' };
  const reason = reasonOf(err);
  if (reason === 'illegal_transition') {
    const from = typeof err.details?.['from'] === 'string' ? (err.details['from'] as string) : current;
    return { code: 'illegal_transition', message: `This change isn’t allowed from ${statusWord(from)}.` };
  }
  if (reason === 'reason_code_required') return { code: reason, message: 'Choose a reason.' };
  if (reason === 'reason_text_required') return { code: reason, message: 'Add the reason details.' };
  if (reason === 'retention_policy_code_required') return { code: reason, message: 'Choose a retention policy.' };
  if (reason === 'close_at_required') return { code: reason, message: 'Choose the close-at date.' };
  return { code: reason ?? err.code ?? `HTTP_${err.status}`, message: err.message || GENERIC };
}

/** The "already in that status" outcome (the API returns changed: false, no error). */
export function alreadyInStatusCopy(status: string): ErrorCopy {
  return { code: 'no_change', message: `No change: this tenant is already ${statusWord(status).toLowerCase()}.` };
}

/** Resend / send owner invite failure → toast copy. */
export function ownerInviteErrorCopy(err: unknown): string {
  if (err instanceof ApiError && reasonOf(err) === 'tenant_not_provisioned') {
    return 'The owner invite can only be sent while the tenant is Provisioned.';
  }
  if (err instanceof ApiError) return `Couldn’t send the owner invite. ${err.message}`.trim();
  return 'Couldn’t send the owner invite. Try again.';
}

/** A domain action failure → copy. */
export function domainErrorCopy(err: unknown): ErrorCopy {
  if (!(err instanceof ApiError)) return { message: GENERIC, code: 'NETWORK_ERROR' };
  const reason = reasonOf(err);
  if (reason === 'organization_domain_taken') {
    return { code: reason, message: 'Another organization already holds this domain.' };
  }
  if (reason === 'no_domain_claim') return { code: reason, message: 'This tenant has no domain claim.' };
  if (reason === 'tenant_has_no_domain') return { code: reason, message: 'This tenant has no email domain.' };
  return { code: reason ?? err.code ?? `HTTP_${err.status}`, message: err.message || GENERIC };
}

// ── Slug (handoff §6.2 step 1) ──

/** The design's slug rule: 1–40 chars, lowercase alphanumerics and inner hyphens. */
export const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

/** The name → slug the design generates when the slug is left empty. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

export const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;
