// PRIV-ADMIN-1 (Privacy Requests Administration v1.0 §1.3) — the console's view of
// a privacy request: labels, the overdue and "Failing" flags, how stored counts
// render (null = "not verified", never 0) and which actions a request offers. The
// server is the authority for every transition; this only decides what to show.

import { ApiError } from '@aramo/fe-foundation';

import type { PillSpec } from '../components';
import type {
  PrivacyChannel,
  PrivacyDeletionPath,
  PrivacyRequestDetail,
  PrivacyRequestStatus,
  PrivacyRequestSummary,
  PrivacyRequestType,
  PrivacySubjectKind,
} from '../platform-api';

export const NOTE_MAX = 2000;

/** Shown wherever a count could not be read (OD-13, C-4). */
export const NOT_VERIFIED = 'not verified';

export const STATUSES: readonly PrivacyRequestStatus[] = [
  'RECEIVED',
  'IDENTITY_VALIDATED',
  'DATA_INVENTORY',
  'REFERRED_TO_ORGANIZATION',
  'EXECUTING',
  'COMPLETED',
  'DENIED_WITH_REASON',
  'CANCELLED',
];
export const TYPES: readonly PrivacyRequestType[] = ['DELETION', 'ACCESS', 'EXPORT', 'CORRECTION'];
export const SUBJECT_KINDS: readonly PrivacySubjectKind[] = [
  'ACCOUNT_HOLDER',
  'BUSINESS_MEMBER',
  'GUEST_SIGNER',
  'FORMER_USER',
  'AUTHORIZED_REPRESENTATIVE',
];
export const CHANNELS: readonly PrivacyChannel[] = ['IN_APP', 'WEB', 'OPERATOR'];

const TERMINAL: ReadonlySet<PrivacyRequestStatus> = new Set([
  'COMPLETED',
  'DENIED_WITH_REASON',
  'CANCELLED',
]);

export const STATUS_PILL: Readonly<Record<PrivacyRequestStatus, PillSpec>> = {
  RECEIVED: { label: 'Received', tone: 'info' },
  IDENTITY_VALIDATED: { label: 'Identity checked', tone: 'info' },
  DATA_INVENTORY: { label: 'In review', tone: 'warn' },
  REFERRED_TO_ORGANIZATION: { label: 'Referred', tone: 'neutral' },
  EXECUTING: { label: 'Executing', tone: 'warn' },
  COMPLETED: { label: 'Completed', tone: 'ok' },
  DENIED_WITH_REASON: { label: 'Denied', tone: 'danger' },
  CANCELLED: { label: 'Cancelled', tone: 'muted' },
};

export function statusPill(s: string): PillSpec {
  return (STATUS_PILL as Record<string, PillSpec | undefined>)[s] ?? { label: s, tone: 'neutral' };
}

export const TYPE_LABEL: Readonly<Record<PrivacyRequestType, string>> = {
  DELETION: 'Deletion',
  ACCESS: 'Access',
  EXPORT: 'Export',
  CORRECTION: 'Correction',
};

export const SUBJECT_KIND_LABEL: Readonly<Record<PrivacySubjectKind, string>> = {
  ACCOUNT_HOLDER: 'Account holder',
  BUSINESS_MEMBER: 'Business member',
  GUEST_SIGNER: 'Guest signer',
  FORMER_USER: 'Former user',
  AUTHORIZED_REPRESENTATIVE: 'Authorized representative',
};

export const CHANNEL_LABEL: Readonly<Record<PrivacyChannel, string>> = {
  IN_APP: 'In app',
  WEB: 'Web',
  OPERATOR: 'Operator',
};

export function label<K extends string>(map: Readonly<Record<K, string>>, v: string): string {
  return (map as Record<string, string | undefined>)[v] ?? v;
}

/** Overdue from the due date (§1.3): still open and past due_at. */
export function isOverdue(
  r: Pick<PrivacyRequestSummary, 'due_at' | 'completed_at' | 'status'>,
  now: Date = new Date(),
): boolean {
  if (r.completed_at !== null || TERMINAL.has(r.status)) return false;
  const due = new Date(r.due_at).getTime();
  return !Number.isNaN(due) && due < now.getTime();
}

export function isTerminal(s: PrivacyRequestStatus): boolean {
  return TERMINAL.has(s);
}

/** The failed attempts a row or detail carries (OD-4). */
export function failureCount(
  r: Pick<PrivacyRequestSummary, 'failing'> & { attempts?: number },
): number {
  const n = r.attempts ?? r.failing ?? 0;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/** "Failing" when one or more attempts failed since the request entered EXECUTING. */
export function isFailing(
  r: Pick<PrivacyRequestSummary, 'failing'> & { attempts?: number },
): boolean {
  return failureCount(r) >= 1;
}

/** "native_sessions_active" → "Native sessions active". */
export function humanize(key: string): string {
  const s = key.replace(/[_.]+/g, ' ').trim().toLowerCase();
  return s.length === 0 ? key : s.charAt(0).toUpperCase() + s.slice(1);
}

export interface CountRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly notVerified: boolean;
}

/**
 * A stored counts object as rows: nested objects are flattened (a.b), null and
 * undefined render "not verified" (never 0), booleans Yes / No.
 */
export function countRows(
  obj: Record<string, unknown> | null | undefined,
  prefix = '',
): CountRow[] {
  if (obj === null || obj === undefined) return [];
  const rows: CountRow[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      rows.push(...countRows(v as Record<string, unknown>, key));
      continue;
    }
    const notVerified = v === null || v === undefined;
    const value = notVerified
      ? NOT_VERIFIED
      : typeof v === 'boolean'
        ? v
          ? 'Yes'
          : 'No'
        : Array.isArray(v)
          ? v.map(String).join(', ') || '—'
          : String(v);
    rows.push({ key, label: humanize(key), value, notVerified });
  }
  return rows;
}

export const PATH_LABEL: Readonly<Record<PrivacyDeletionPath, string>> = {
  personal_full:
    'Personal account, full deletion: Sign data deleted, the account closed and its sign-in removed',
  personal_retain:
    'Personal account, sign-in kept: Sign data deleted; the sign-in identity stays because something else depends on it',
  member:
    'Business member: sessions ended and their own convenience data removed; the organization’s documents and access settings stay',
  not_executable: 'Not executable',
};

export function pathLabel(p: string): string {
  return (PATH_LABEL as Record<string, string | undefined>)[p] ?? p;
}

export type PrivacyAction =
  | 'assign'
  | 'validate'
  | 'inventory'
  | 'refer'
  | 'execute'
  | 'complete'
  | 'deny'
  | 'cancel'
  | 'note'
  | 'returnToQueue';

/** The actions a request offers now, in display order (§1.3; draft §3 "Allowed when"). */
export function availableActions(
  r: PrivacyRequestDetail,
  operatorId: string | null,
): PrivacyAction[] {
  const out: PrivacyAction[] = [];
  const open = !isTerminal(r.status);
  if (open && (operatorId === null || r.assigned_operator_id !== operatorId)) out.push('assign');
  if (r.status === 'RECEIVED') out.push('validate');
  if (r.status === 'IDENTITY_VALIDATED') out.push('inventory');
  if (r.status === 'DATA_INVENTORY' && r.subject_tenant_id !== null) out.push('refer');
  if (
    r.request_type === 'DELETION' &&
    (r.status === 'DATA_INVENTORY' || r.status === 'REFERRED_TO_ORGANIZATION') &&
    r.execution_enabled
  ) {
    out.push('execute');
  }
  // OD-1: a DELETION never completes by hand. OD-2: the other types from review or referral.
  if (
    r.request_type !== 'DELETION' &&
    (r.status === 'DATA_INVENTORY' || r.status === 'REFERRED_TO_ORGANIZATION')
  )
    out.push('complete');
  if (r.status === 'EXECUTING') out.push('returnToQueue');
  if (open && r.status !== 'EXECUTING') out.push('deny', 'cancel');
  out.push('note');
  return out;
}

export const ACTION_BUTTON: Readonly<Record<PrivacyAction, string>> = {
  assign: 'Assign to me',
  validate: 'Record identity check…',
  inventory: 'Take inventory…',
  refer: 'Refer to organization…',
  execute: 'Execute deletion…',
  complete: 'Record outcome…',
  deny: 'Deny…',
  cancel: 'Cancel request…',
  note: 'Add note…',
  returnToQueue: 'Return to queue…',
};

/** The last EXECUTION_FAILED error name in the history, if any. */
export function lastFailure(r: Pick<PrivacyRequestDetail, 'events'>): string | null {
  for (const e of [...r.events].reverse()) {
    if (e.event_type === 'EXECUTION_FAILED') {
      const p = e.payload;
      const name = p['error'] ?? p['error_name'] ?? p['name'];
      return typeof name === 'string' ? name : 'unknown';
    }
  }
  return null;
}

export const EVENT_LABEL: Readonly<Record<string, string>> = {
  CREATED: 'Request received',
  STATUS_CHANGED: 'Status changed',
  ASSIGNED: 'Assigned',
  NOTE: 'Note',
  CONTACT_REVEALED: 'Contact revealed',
  RETURNED_TO_QUEUE: 'Returned to queue',
  EXECUTION_FAILED: 'Execution failed',
  EXECUTION_GAVE_UP: 'Execution stopped after repeated failures',
  LEGAL_HOLD: 'Legal hold',
  ACCOUNT_CLOSED: 'Account closed',
  IDENTITY_RETIREMENT_REFERRED: 'Sign-in removal referred',
};

export function eventLabel(t: string): string {
  return EVENT_LABEL[t] ?? humanize(t);
}

export const ACTOR_LABEL: Readonly<Record<string, string>> = {
  SUBJECT: 'Requester',
  OPERATOR: 'Operator',
  SYSTEM: 'System',
};

function reasonOf(e: ApiError): string | undefined {
  const r = e.details?.['reason'];
  return typeof r === 'string' ? r : undefined;
}

const REFUSAL: Readonly<Record<string, string>> = {
  privacy_deletion_completes_by_execution:
    'A deletion completes only by execution. Execute it, or deny it.',
  privacy_referral_tenant_mismatch:
    'A request can be referred only to the requester’s own organization.',
  privacy_execution_disabled: 'Deletion execution is not enabled.',
  privacy_no_account_subject: 'No Aramo Sign account was found for this request.',
  privacy_subject_mismatch: 'The requester no longer belongs to the inventoried organization.',
  privacy_legal_hold: 'The organization is under legal hold. Nothing can be deleted.',
  privacy_execution_in_progress: 'The deletion is running. It completes by itself.',
  organization_required: 'No organization is known for this request.',
};

/** A refused action → operator copy, with the server reason code. */
export function privacyErrorText(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return fallback;
  const reason = reasonOf(e);
  if (reason !== undefined && REFUSAL[reason] !== undefined)
    return `${REFUSAL[reason]} (${reason})`;
  return reason !== undefined ? `${e.message} (${reason})` : e.message;
}
