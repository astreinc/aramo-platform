import type { ConfirmTone } from '../components';

// PLATFORM-UX-1 F-5 (directive R-15; handoff §7) — the ONE config file for the
// tenant lifecycle actions: the transitions allowed from each status, each
// action's consequence, fields and reason-code list, and the human labels for
// every reason code the console shows. The per-action lists are the design's
// (a product decision adopted by R-15); the backend accepts any non-empty code,
// so this file only OFFERS — the transition service stays authoritative.

export type TenantStatus = 'PROVISIONED' | 'ACTIVE' | 'SUSPENDED' | 'OFFBOARDING' | 'CLOSED';

export type LifecycleActionKey = 'suspend' | 'reactivate' | 'offboard' | 'close';

/** Status → the transitions an operator may start (handoff §7; mirrors the service table). */
export const ALLOWED_ACTIONS: Readonly<Record<TenantStatus, readonly LifecycleActionKey[]>> = {
  // Active happens automatically on the owner's first sign-in: no button.
  PROVISIONED: ['close'],
  ACTIVE: ['suspend', 'offboard'],
  SUSPENDED: ['reactivate', 'offboard'],
  OFFBOARDING: ['close'],
  CLOSED: [],
};

/** The allowed actions for a status; an unknown status allows none. */
export function allowedActions(status: string): readonly LifecycleActionKey[] {
  return (ALLOWED_ACTIONS as Readonly<Record<string, readonly LifecycleActionKey[]>>)[status] ?? [];
}

/** Every reason code the console labels: lifecycle actions, system transitions, invites. */
export const REASON_LABEL: Readonly<Record<string, string>> = {
  // Suspend
  payment_overdue: 'Payment overdue',
  terms_violation: 'Terms of service violation',
  security_incident: 'Security incident',
  legal_hold: 'Legal hold',
  owner_request: 'Owner request',
  // Reactivate
  issue_resolved: 'Issue resolved',
  payment_received: 'Payment received',
  suspended_in_error: 'Suspended in error',
  // Start offboarding
  contract_ended: 'Contract ended',
  consolidation: 'Merged into another tenant',
  // Close
  offboarding_complete: 'Offboarding complete',
  never_activated: 'Never activated',
  duplicate_tenant: 'Duplicate tenant',
  // System and invite reasons recorded by the backend
  illegal_transition: 'Not an allowed transition',
  owner_first_session: 'Owner first sign-in',
  first_send: 'First invite',
  resend: 'Invite resent',
  // Retention policies (the offboarding event can carry one)
  standard_90d: 'Standard retention',
  extended_365d: 'Extended retention',
};

/**
 * The human label for a reason code. An unknown code returns a sentence-cased
 * form of the code ("ops_hold" → "Ops hold"): the raw code is shown beside it in
 * mono, never as the label.
 */
export function reasonLabel(code: string): string {
  const known = REASON_LABEL[code];
  if (known !== undefined) return known;
  const words = code.replace(/[_.:-]+/g, ' ').trim().toLowerCase();
  return words.length === 0 ? code : words.charAt(0).toUpperCase() + words.slice(1);
}

export interface ReasonOption {
  readonly value: string;
  readonly label: string;
}

const options = (...codes: string[]): readonly ReasonOption[] =>
  codes.map((c) => ({ value: c, label: reasonLabel(c) }));

/** Retention policies offered when starting offboarding (stored opaquely server-side). */
export const RETENTION_POLICIES: readonly ReasonOption[] = [
  { value: 'standard_90d', label: 'Standard — keep data 90 days after close' },
  { value: 'extended_365d', label: 'Extended — keep data 365 days after close' },
  { value: 'legal_hold', label: 'Legal hold — keep until released' },
];

export type LifecycleField =
  | { readonly key: 'code'; readonly type: 'select'; readonly label: string; readonly required: boolean; readonly placeholder: string; readonly options: readonly ReasonOption[] }
  | { readonly key: 'retention'; readonly type: 'select'; readonly label: string; readonly required: true; readonly placeholder: string; readonly helper: string; readonly options: readonly ReasonOption[] }
  | { readonly key: 'closeAt'; readonly type: 'date'; readonly label: string; readonly required: true }
  | { readonly key: 'text'; readonly type: 'textarea'; readonly label: string; readonly required: boolean; readonly max: number; readonly helper?: string }
  | { readonly key: 'ack'; readonly type: 'check'; readonly label: string; readonly required: true };

export interface LifecycleActionConfig {
  readonly key: LifecycleActionKey;
  /** Menu and button label. */
  readonly label: string;
  /** The one-line description in the menu. */
  readonly description: string;
  readonly to: TenantStatus;
  readonly tone: Exclude<ConfirmTone, 'normal'>;
  readonly commit: string;
  readonly consequence: string;
  readonly fields: readonly LifecycleField[];
}

export const LIFECYCLE_ACTIONS: Readonly<Record<LifecycleActionKey, LifecycleActionConfig>> = {
  suspend: {
    key: 'suspend',
    label: 'Suspend',
    description: 'Block sign-in and freeze writes. Reversible.',
    to: 'SUSPENDED',
    tone: 'privileged',
    commit: 'Suspend tenant',
    consequence: 'No one in this tenant can sign in, and all writes are frozen until it is reactivated. Data is kept.',
    fields: [
      {
        key: 'code',
        type: 'select',
        label: 'Reason',
        required: true,
        placeholder: 'Choose a reason',
        options: options('payment_overdue', 'terms_violation', 'security_incident', 'legal_hold', 'owner_request'),
      },
      { key: 'text', type: 'textarea', label: 'Reason details', required: true, max: 500, helper: 'Recorded in the tenant audit trail.' },
    ],
  },
  reactivate: {
    key: 'reactivate',
    label: 'Reactivate',
    description: 'Restore sign-in and writes.',
    to: 'ACTIVE',
    tone: 'privileged',
    commit: 'Reactivate tenant',
    consequence: 'Users can sign in again and writes resume immediately.',
    fields: [
      {
        key: 'code',
        type: 'select',
        label: 'Reason',
        required: true,
        placeholder: 'Choose a reason',
        options: options('issue_resolved', 'payment_received', 'suspended_in_error', 'owner_request'),
      },
    ],
  },
  offboard: {
    key: 'offboard',
    label: 'Start offboarding',
    description: 'Begin a wind-down toward closing.',
    to: 'OFFBOARDING',
    tone: 'privileged',
    commit: 'Start offboarding',
    consequence:
      'The tenant enters a wind-down period. Data is kept under the retention policy you choose, and the tenant can be closed on or after the close-at date.',
    fields: [
      {
        key: 'retention',
        type: 'select',
        label: 'Retention policy',
        required: true,
        placeholder: 'Choose a policy',
        helper: 'How long tenant data is kept after the tenant closes.',
        options: RETENTION_POLICIES,
      },
      { key: 'closeAt', type: 'date', label: 'Close at', required: true },
      {
        key: 'code',
        type: 'select',
        label: 'Reason (optional)',
        required: false,
        placeholder: 'No reason code',
        options: options('contract_ended', 'owner_request', 'consolidation'),
      },
      { key: 'text', type: 'textarea', label: 'Notes (optional)', required: false, max: 500 },
    ],
  },
  close: {
    key: 'close',
    label: 'Close tenant',
    description: 'Terminal. Cannot be undone.',
    to: 'CLOSED',
    tone: 'danger',
    commit: 'Close tenant permanently',
    consequence: 'Closing is terminal. No one can sign in, writes are frozen permanently, and the tenant cannot be reopened.',
    fields: [
      {
        key: 'code',
        type: 'select',
        label: 'Reason',
        required: true,
        placeholder: 'Choose a reason',
        options: options('offboarding_complete', 'never_activated', 'duplicate_tenant', 'owner_request'),
      },
      { key: 'text', type: 'textarea', label: 'Notes (optional)', required: false, max: 500 },
      { key: 'ack', type: 'check', label: 'I understand closing is terminal and cannot be undone.', required: true },
    ],
  },
};

export interface LifecycleValues {
  readonly code: string;
  readonly retention: string;
  readonly closeAt: string;
  readonly text: string;
  readonly ack: boolean;
}

export const EMPTY_LIFECYCLE_VALUES: LifecycleValues = { code: '', retention: '', closeAt: '', text: '', ack: false };

/** True when every required field of the action has a value. */
export function lifecycleValuesComplete(action: LifecycleActionKey, v: LifecycleValues): boolean {
  return LIFECYCLE_ACTIONS[action].fields.every((f) => {
    if (!f.required) return true;
    if (f.key === 'ack') return v.ack;
    return v[f.key].trim().length > 0;
  });
}
