// CCP-D3 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.4 row D3: "billing and approval metrics,
// alerts, exception management"; Out: "health or rating metrics", PLATFORM-UX-1 :139) — the pure
// model of the operator-visible exception register (subscription."CommercialOperationalAlert",
// migration 20261026090000).
//
// An alert names ONE subject (a command, a webhook inbox row, a reconciliation flag, a usage metric
// or a change request) and the condition observed on it. It never grades, orders or compares
// tenants, and carries no money. It is raised and resolved only by the scanner
// (commercial-alert.service.ts), which reads the source tables and never changes them: resolving
// the underlying condition stays on the governed paths (retry, change request, conversion).

export const COMMERCIAL_ALERT_FAMILIES = ['BILLING', 'APPROVAL'] as const;
export type CommercialAlertFamily = (typeof COMMERCIAL_ALERT_FAMILIES)[number];

export const COMMERCIAL_ALERT_STATUSES = ['OPEN', 'RESOLVED'] as const;
export type CommercialAlertStatus = (typeof COMMERCIAL_ALERT_STATUSES)[number];

export type CommercialAlertSubjectKind = 'billing_command' | 'reconciliation_flag' | 'webhook_inbox' | 'usage_metric' | 'change_request';

/** The closed set (mirrors the migration's type CHECK, which also pins family and subject kind). */
export const COMMERCIAL_ALERT_DEFINITIONS = {
  // A Stripe command the provider accepted whose effect has not been confirmed (C-23) for at least
  // the configured threshold (TD-C1-10).
  COMMAND_PENDING_PROVIDER_STUCK: { family: 'BILLING', subject_kind: 'billing_command' },
  // A Stripe command in FAILED (retries exhausted, provider refusal, pre-call refusal) (TD-C1-7).
  COMMAND_FAILED: { family: 'BILLING', subject_kind: 'billing_command' },
  // A self-service activation held because a governed subscription is open (Conv. C-7, C-8; A6).
  HELD_ACTIVATION: { family: 'BILLING', subject_kind: 'reconciliation_flag' },
  // A verified provider event whose processing failed (C1 inbox FAILED).
  WEBHOOK_INBOX_FAILED: { family: 'BILLING', subject_kind: 'webhook_inbox' },
  // The latest CCP-D1 roll-up run of a metric did not reconcile to the allowance ledger.
  USAGE_NOT_RECONCILED: { family: 'BILLING', subject_kind: 'usage_metric' },
  // A governed apply that failed and waits for a retry (A6).
  APPLY_FAILED: { family: 'APPROVAL', subject_kind: 'change_request' },
  // A request still awaiting approval whose expiry falls within the configured lead time (A3).
  APPROVAL_NEARING_EXPIRY: { family: 'APPROVAL', subject_kind: 'change_request' },
  // A request still PENDING_APPROVAL at or after its expiry (A3 expiry is lazy, TD-A3-10).
  APPROVAL_PAST_EXPIRY: { family: 'APPROVAL', subject_kind: 'change_request' },
  // CCP-FIX1 (closes TD-D3-10; Charter Amendment A1 AD-1 … AD-4): an APPROVED or APPLY_FAILED request
  // whose SNAPSHOTTED policy declares apply_expiry_hours, with its apply deadline within the approval
  // expiry lead (CCP_ALERT_APPROVAL_EXPIRY_LEAD_MINUTES) …
  APPLY_DEADLINE_NEARING: { family: 'APPROVAL', subject_kind: 'change_request' },
  // … or at or past it (half-open, AD-3) while it still reads APPROVED / APPLY_FAILED (the expiry
  // itself is lazy, AD-7: the next apply, slot-contending create or read moves it to APPLY_EXPIRED).
  APPLY_DEADLINE_PASSED: { family: 'APPROVAL', subject_kind: 'change_request' },
} as const satisfies Record<string, { family: CommercialAlertFamily; subject_kind: CommercialAlertSubjectKind }>;

export type CommercialAlertType = keyof typeof COMMERCIAL_ALERT_DEFINITIONS;
export const COMMERCIAL_ALERT_TYPES = Object.keys(COMMERCIAL_ALERT_DEFINITIONS) as CommercialAlertType[];

export function commercialAlertTypesOf(family: CommercialAlertFamily): CommercialAlertType[] {
  return COMMERCIAL_ALERT_TYPES.filter((t) => COMMERCIAL_ALERT_DEFINITIONS[t].family === family);
}

// ---- Thresholds (operational configuration, never commercial policy; pre-execution D3-C3) -----------

export const CCP_ALERT_PENDING_PROVIDER_STUCK_MINUTES_DEFAULT = 1440;
export const CCP_ALERT_APPROVAL_EXPIRY_LEAD_MINUTES_DEFAULT = 720;
/** Upper bound for either threshold (30 days); an out-of-range or malformed value falls back to the default. */
export const CCP_ALERT_THRESHOLD_MAX_MINUTES = 43_200;

export interface CommercialAlertThresholds {
  /** COMMAND_PENDING_PROVIDER_STUCK: minutes since the provider accepted the command. */
  pending_provider_stuck_minutes: number;
  /** APPROVAL_NEARING_EXPIRY: minutes before `expires_at`; APPLY_DEADLINE_NEARING: minutes before the apply deadline (CCP-FIX1 reuses it). */
  approval_expiry_lead_minutes: number;
}

function minutesFrom(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^\d+$/.test(raw.trim())) return fallback;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n >= 1 && n <= CCP_ALERT_THRESHOLD_MAX_MINUTES ? n : fallback;
}

export function commercialAlertThresholds(env: NodeJS.ProcessEnv = process.env): CommercialAlertThresholds {
  return {
    pending_provider_stuck_minutes: minutesFrom(env['CCP_ALERT_PENDING_PROVIDER_STUCK_MINUTES'], CCP_ALERT_PENDING_PROVIDER_STUCK_MINUTES_DEFAULT),
    approval_expiry_lead_minutes: minutesFrom(env['CCP_ALERT_APPROVAL_EXPIRY_LEAD_MINUTES'], CCP_ALERT_APPROVAL_EXPIRY_LEAD_MINUTES_DEFAULT),
  };
}

// ---- Detection and the register diff ----------------------------------------------------------

/** One condition the scanner observed on one subject. */
export interface DetectedCondition {
  alert_type: CommercialAlertType;
  subject_id: string;
  tenant_id: string | null;
  product_key: string | null;
  detail: string;
  evidence: Record<string, unknown>;
  threshold_minutes: number | null;
}

export interface OpenAlertKey {
  id: string;
  alert_type: string;
  subject_id: string;
}

export const alertKey = (alert_type: string, subject_id: string): string => `${alert_type}\u0000${subject_id}`;

export interface AlertDiff<T extends OpenAlertKey> {
  raise: DetectedCondition[];
  refresh: { open: T; condition: DetectedCondition }[];
  resolve: T[];
}

/**
 * The register diff for one scan. A type whose source was not fully read (`unread`: unavailable or
 * truncated) never resolves its open alerts: absence of evidence is not resolution.
 */
export function diffAlerts<T extends OpenAlertKey>(open: readonly T[], detected: readonly DetectedCondition[], unread: ReadonlySet<string> = new Set()): AlertDiff<T> {
  const openByKey = new Map(open.map((a) => [alertKey(a.alert_type, a.subject_id), a]));
  const seen = new Set<string>();
  const raise: DetectedCondition[] = [];
  const refresh: { open: T; condition: DetectedCondition }[] = [];
  for (const c of detected) {
    const k = alertKey(c.alert_type, c.subject_id);
    if (seen.has(k)) continue;
    seen.add(k);
    const o = openByKey.get(k);
    if (o === undefined) raise.push(c);
    else refresh.push({ open: o, condition: c });
  }
  const resolve = open.filter((a) => !seen.has(alertKey(a.alert_type, a.subject_id)) && !unread.has(a.alert_type));
  return { raise, refresh, resolve };
}

// ---- Structured log events (one JSON line each; counts and ids only, never a payload) ---------

export const CCP_ALERT_RAISED_EVENT = 'ccp_alert_raised';
export const CCP_ALERT_RESOLVED_EVENT = 'ccp_alert_resolved';
export const CCP_ALERT_SCAN_EVENT = 'ccp_alert_scan';
