import { randomBytes } from 'node:crypto';

// Aramo-Sign-Mobile-Amendment-M-A7 §3.1 — the ONE platform privacy-request
// capability (the Sign instance of TM-L12's rights-request path). Pure model:
// the vocabularies, the status lifecycle and the public reference format. The
// database CHECKs (migration 20261030030000_privacy_requests) mirror these lists.

export const PRIVACY_REQUEST_TYPES = ['DELETION', 'ACCESS', 'EXPORT', 'CORRECTION'] as const;
export type PrivacyRequestType = (typeof PRIVACY_REQUEST_TYPES)[number];

export const PRIVACY_SUBJECT_KINDS = ['ACCOUNT_HOLDER', 'BUSINESS_MEMBER', 'GUEST_SIGNER', 'FORMER_USER', 'AUTHORIZED_REPRESENTATIVE'] as const;
export type PrivacySubjectKind = (typeof PRIVACY_SUBJECT_KINDS)[number];

export const PRIVACY_CHANNELS = ['IN_APP', 'WEB', 'OPERATOR'] as const;
export type PrivacyChannel = (typeof PRIVACY_CHANNELS)[number];

export const PRIVACY_PRODUCTS = ['SIGN'] as const;
export type PrivacyProduct = (typeof PRIVACY_PRODUCTS)[number];

export const PRIVACY_REQUEST_STATUSES = [
  'RECEIVED',
  'IDENTITY_VALIDATED',
  'DATA_INVENTORY',
  'REFERRED_TO_ORGANIZATION',
  'EXECUTING',
  'COMPLETED',
  'DENIED_WITH_REASON',
  'CANCELLED',
] as const;
export type PrivacyRequestStatus = (typeof PRIVACY_REQUEST_STATUSES)[number];

export const PRIVACY_TERMINAL_STATUSES: ReadonlySet<PrivacyRequestStatus> = new Set(['COMPLETED', 'DENIED_WITH_REASON', 'CANCELLED']);

export type PrivacyActorType = 'SUBJECT' | 'OPERATOR' | 'SYSTEM';

// §3.1 lifecycle: RECEIVED → IDENTITY_VALIDATED → DATA_INVENTORY →
// (REFERRED_TO_ORGANIZATION | EXECUTING) → COMPLETED | DENIED_WITH_REASON | CANCELLED.
// Two additions, both recorded as Executor decisions:
//   REFERRED_TO_ORGANIZATION → EXECUTING  Aramo stays the accountable fallback: after a
//                                         referral Aramo still acts on the requester's
//                                         own data (a Business member's sessions,
//                                         convenience data and Sign access).
//   EXECUTING → DATA_INVENTORY            an execution that meets a legal hold (or fails)
//                                         goes back to the operator queue; nothing is
//                                         deleted while a hold stands.
export const PRIVACY_TRANSITIONS: Readonly<Record<PrivacyRequestStatus, readonly PrivacyRequestStatus[]>> = {
  RECEIVED: ['IDENTITY_VALIDATED', 'DENIED_WITH_REASON', 'CANCELLED'],
  IDENTITY_VALIDATED: ['DATA_INVENTORY', 'DENIED_WITH_REASON', 'CANCELLED'],
  DATA_INVENTORY: ['REFERRED_TO_ORGANIZATION', 'EXECUTING', 'DENIED_WITH_REASON', 'CANCELLED'],
  REFERRED_TO_ORGANIZATION: ['EXECUTING', 'COMPLETED', 'DENIED_WITH_REASON', 'CANCELLED'],
  EXECUTING: ['COMPLETED', 'DATA_INVENTORY'],
  COMPLETED: [],
  DENIED_WITH_REASON: [],
  CANCELLED: [],
};

export function isPrivacyTransitionLegal(from: PrivacyRequestStatus, to: PrivacyRequestStatus): boolean {
  return PRIVACY_TRANSITIONS[from].includes(to);
}

export function isPrivacyRequestType(v: unknown): v is PrivacyRequestType {
  return typeof v === 'string' && (PRIVACY_REQUEST_TYPES as readonly string[]).includes(v);
}

export function isPrivacySubjectKind(v: unknown): v is PrivacySubjectKind {
  return typeof v === 'string' && (PRIVACY_SUBJECT_KINDS as readonly string[]).includes(v);
}

export function isPrivacyRequestStatus(v: unknown): v is PrivacyRequestStatus {
  return typeof v === 'string' && (PRIVACY_REQUEST_STATUSES as readonly string[]).includes(v);
}

// §3.1 "a due date of 30 days".
export const PRIVACY_REQUEST_DUE_MS = 30 * 24 * 60 * 60 * 1000;

export function privacyRequestDueAt(created_at: Date): Date {
  return new Date(created_at.getTime() + PRIVACY_REQUEST_DUE_MS);
}

// The stable public reference: PR- + three groups of four Crockford base32 symbols
// (60 random bits). Unambiguous to read aloud (no I, L, O, U).
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PRIVACY_REFERENCE_PATTERN = /^PR-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

export function newPrivacyReference(bytes: Buffer = randomBytes(12)): string {
  let out = '';
  for (let i = 0; i < 12; i += 1) out += CROCKFORD[(bytes[i] ?? 0) % 32];
  return `PR-${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

/** Normalizes a typed reference (case, spaces, the optional prefix) or returns null. */
export function normalizePrivacyReference(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase().replace(/\s+/g, '');
  return PRIVACY_REFERENCE_PATTERN.test(s) ? s : null;
}

/** What the requester sees for each status (a meaningful status, §3.1). */
export const PRIVACY_STATUS_LABEL: Readonly<Record<PrivacyRequestStatus, string>> = {
  RECEIVED: 'Received',
  IDENTITY_VALIDATED: 'Identity confirmed',
  DATA_INVENTORY: 'Being reviewed by the Aramo privacy team',
  REFERRED_TO_ORGANIZATION: 'Referred to your organization (Aramo remains responsible)',
  EXECUTING: 'In progress',
  COMPLETED: 'Completed',
  DENIED_WITH_REASON: 'Declined (see the reason)',
  CANCELLED: 'Cancelled',
};

// §3.2 "Execution is staged" — destructive execution of an Aramo Sign deletion runs
// only when SIGN_PRIVACY_DELETION_EXECUTION_ENABLED=1. OFF by default (unset, empty or
// any other value). With it off, requests are received, validated, inventoried and
// queued for the Aramo privacy team; nothing is deleted. Production enablement needs a
// separate authorization (amendment §8).
export const SIGN_PRIVACY_DELETION_EXECUTION_FLAG = 'SIGN_PRIVACY_DELETION_EXECUTION_ENABLED';

export function privacyDeletionExecutionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SIGN_PRIVACY_DELETION_EXECUTION_FLAG] === '1';
}
