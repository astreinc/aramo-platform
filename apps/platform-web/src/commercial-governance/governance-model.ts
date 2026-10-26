import type {
  AuditEvent,
  ChainKey,
  ChainState,
  PolicyContent,
  PolicyEditableKey,
  PolicyVersion,
  RosterOperator,
} from './governance-api';

// CCP-B5 — the pure presentation model of the governance screens (handoff §3, §5.6–§5.8):
// role / step / chain labels, the policy settings table, the audit row mapping and the
// role-change plan. No I/O. Every copy string is the design file's
// (doc/design-reference/ccp/CCP-UI-v1_0/Commercial Control Plane v1.0.dc.html), except
// where a ruling or a data gap changes it (each is a typed divergence in
// doc/ccp/slices/CCP-B5-acceptance.md).

export const COMMERCIAL_ROLES = [
  'platform_owner',
  'finance_admin',
  'commercial_ops',
  'catalog_manager',
  'support_admin',
  'read_only_auditor',
] as const;
export type CommercialRole = (typeof COMMERCIAL_ROLES)[number];

export const ROLE_LABEL: Readonly<Record<string, string>> = {
  platform_owner: 'Platform owner',
  finance_admin: 'Finance admin',
  commercial_ops: 'Commercial ops',
  catalog_manager: 'Catalog manager',
  support_admin: 'Support admin',
  read_only_auditor: 'Read-only auditor',
  super_admin: 'Super admin',
};
export const STEP_LABEL: Readonly<Record<string, string>> = {
  finance_admin: 'Finance',
  platform_owner: 'Owner',
};
export const PRIVILEGED_ROLES: readonly string[] = ['platform_owner', 'finance_admin'];

export const CHAIN_LABEL: Readonly<Record<ChainKey, string>> = {
  ABOVE_THRESHOLD: 'Above threshold',
  BELOW_THRESHOLD: 'Below threshold',
  CATALOG_PUBLISH: 'Catalog publish',
  ROLE_CHANGE: 'Role change (privileged)',
  POLICY_CHANGE: 'Policy change',
};

export const roleLabel = (k: string): string => ROLE_LABEL[k] ?? k;
export const stepsText = (roles: readonly string[]): string =>
  roles.map((r) => STEP_LABEL[r] ?? roleLabel(r)).join(' → ');

/** "Maker: Commercial ops or Support admin → Finance → Owner" (handoff §5.8). */
export function chainLine(c: Pick<ChainState, 'maker_roles' | 'step_roles'>): string {
  return `Maker: ${c.maker_roles.map(roleLabel).join(' or ')} → ${stepsText(c.step_roles)}`;
}
/** The why line under a chain's pill. */
export function chainWhy(
  c: Pick<ChainState, 'fulfillable' | 'missing' | 'step_roles' | 'maker_roles'>,
): string {
  if (c.fulfillable) return 'Enough distinct people hold these roles.';
  if (c.missing === 'maker')
    return `Needs a person with ${c.maker_roles.map(roleLabel).join(' or ')}.`;
  return `Needs more distinct people with ${[...new Set(c.step_roles)].map(roleLabel).join(' and ')}.`;
}

// ---- dates (UTC; handoff §5) ------------------------------------------------------------

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n: number): string => String(n).padStart(2, '0');
/** "24 Oct 2026". */
export function fmtDay(iso: string | null): string {
  if (iso === null) return '—';
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
/** "2026-10-24 14:00 UTC". */
export function fmtUtc(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} UTC`;
}

// ---- policy (handoff §5.6) ----------------------------------------------------------------

export const money = (dollars: number): string =>
  `$${dollars.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

export interface PolicyField {
  readonly key: PolicyEditableKey;
  readonly label: string;
  readonly help: string;
  /** Document units → the number shown and edited (%, $, days, hours). */
  readonly toUi: (v: number) => number;
  /** The edited number → document units. */
  readonly fromUi: (v: number) => number;
  readonly format: (ui: number) => string;
  /** Allowed range in UI units (handoff §5.6). */
  readonly min: number;
  readonly max: number;
  /**
   * CCP-FIX1 — an OPTIONAL key (absent = not set, never defaulted). Its row is shown when this
   * version or the active one declares it, or while a draft is being edited.
   */
  readonly optional?: boolean;
}

const id = (v: number): number => v;
/**
 * The seven settings, in the design order. The two threshold help lines follow the PO's
 * boundary semantics (A2-B: at or above the threshold escalates), not the design's "above".
 */
export const POLICY_FIELDS: readonly PolicyField[] = [
  {
    key: 'discount_escalation_threshold_bps',
    label: 'Discount approval threshold',
    help: 'Discounts at or above this need Finance → Owner; below, Finance only.',
    toUi: (v) => v / 100,
    fromUi: (v) => Math.round(v * 100),
    format: (v) => `${v}%`,
    min: 0,
    max: 100,
  },
  {
    key: 'credit_escalation_threshold_minor',
    label: 'Credit approval threshold',
    help: 'Credits at or above this need Finance → Owner; below, Finance only.',
    toUi: (v) => v / 100,
    fromUi: (v) => Math.round(v * 100),
    format: (v) => money(v),
    min: 0,
    max: 100_000,
  },
  {
    key: 'support_extension_max_days',
    label: 'Support extension, per use',
    help: 'Within bounds, an extension applies with zero approvals as an exception.',
    toUi: id,
    fromUi: id,
    format: (v) => `${v} days`,
    min: 1,
    max: 60,
  },
  {
    key: 'support_extension_frequency_window_days',
    label: 'Support extension frequency',
    help: 'Rolling window.',
    toUi: id,
    fromUi: id,
    format: (v) => `once per tenant per ${v} days`,
    min: 30,
    max: 365,
  },
  {
    key: 'support_extension_cumulative_max_days',
    label: 'Support extension, cumulative cap',
    help: 'Total extension days inside the window.',
    toUi: id,
    fromUi: id,
    format: (v) => `${v} days`,
    min: 1,
    max: 120,
  },
  {
    key: 'approval_expiry_hours',
    label: 'Approval window (TTL)',
    help: 'A request expires if its chain isn’t complete in time.',
    toUi: id,
    fromUi: id,
    format: (v) => `${v} h`,
    min: 12,
    max: 168,
  },
  {
    key: 'past_due_grace_days',
    label: 'Past-due grace',
    help: 'Days after a failed payment before the subscription is suspended.',
    toUi: id,
    fromUi: id,
    format: (v) => `${v} days`,
    min: 0,
    max: 30,
  },
  // CCP-FIX1 (D5-DEF-2; Charter Amendment A1 AD-1) — the optional apply deadline. Not in the
  // CCP-UI v1.0 design (it predates the amendment); the range is the strict policy parser's
  // (1 … 87,600 h), never a handoff range. Absent = no apply deadline (AD-2).
  {
    key: 'apply_expiry_hours',
    label: 'Apply deadline (TTL)',
    help: 'An approved request must be applied within this time of its final approval.',
    toUi: id,
    fromUi: id,
    format: (v) => `${v} h`,
    min: 1,
    max: 87_600,
    optional: true,
  },
];

/** The label an optional setting shows when a version does not declare it. */
export const NOT_SET = 'Not set';

export interface PolicyRow {
  readonly field: PolicyField;
  readonly active: string;
  readonly mine: string;
  readonly raw: number;
  /** False only for an optional setting this version does not declare (CCP-FIX1). */
  readonly declared: boolean;
  readonly changed: boolean;
}

/**
 * The settings table of `v` against the active version (handoff §5.6). An optional setting
 * (CCP-FIX1) has a row only when `v` or the active version declares it, or when
 * `includeOptional` (the draft editor) asks for it; an undeclared value reads "Not set".
 */
export function policyRows(
  v: PolicyVersion,
  active: PolicyVersion | undefined,
  opts: { includeOptional?: boolean } = {},
): PolicyRow[] {
  const vc = v.content;
  const ac = active?.content ?? null;
  const declares = (c: PolicyContent | null, f: PolicyField): boolean =>
    c !== null && typeof c[f.key] === 'number';
  return POLICY_FIELDS.filter(
    (f) => f.optional !== true || opts.includeOptional === true || declares(vc, f) || declares(ac, f),
  ).map((f) => {
    const value = (c: PolicyContent | null): number | null | undefined =>
      c === null ? null : declares(c, f) ? f.toUi(c[f.key] as number) : undefined;
    const mine = value(vc);
    const act = value(ac);
    const show = (x: number | null | undefined): string =>
      x === null ? '—' : x === undefined ? NOT_SET : f.format(x);
    return {
      field: f,
      active: show(act),
      mine: show(mine),
      raw: mine ?? 0,
      declared: mine !== null && mine !== undefined,
      changed: mine !== null && act !== null && mine !== act,
    };
  });
}

/** The activation dialog's Before → after rows: every changed setting, or "no change". */
export function activationDiff(
  v: PolicyVersion,
  active: PolicyVersion | undefined,
): Array<[string, string, string]> {
  const rows = policyRows(v, active)
    .filter((r) => r.changed)
    .map((r): [string, string, string] => [r.field.label, r.active, r.mine]);
  return rows.length > 0
    ? rows
    : [['All settings', `Same as v${active?.version_number ?? '?'}`, 'No change']];
}

/** Clamps an edited UI number into the field's range (the design's input behaviour). */
export function clampUi(f: PolicyField, raw: string): number {
  const n = Number(raw);
  return Math.max(f.min, Math.min(f.max, Number.isFinite(n) ? n : 0));
}

export function policyPill(status: PolicyVersion['status']): {
  label: string;
  tone: 'ok' | 'neutral' | 'muted';
} {
  return status === 'ACTIVE'
    ? { label: 'Active', tone: 'ok' }
    : status === 'DRAFT'
      ? { label: 'Draft', tone: 'neutral' }
      : { label: 'Retired', tone: 'muted' };
}

export const STATE_LABEL: Readonly<Record<string, string>> = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Pending approval',
  APPROVED: 'Approved',
  APPLYING: 'Applying',
  APPLIED: 'Applied',
  APPLY_FAILED: 'Apply failed',
  REJECTED: 'Rejected',
  EXPIRED: 'Expired',
  WITHDRAWN: 'Withdrawn',
  APPLY_EXPIRED: 'Apply expired',
};

// ---- people -----------------------------------------------------------------------------

export function personName(
  o: Pick<RosterOperator, 'display_name' | 'email' | 'user_id'> | undefined,
  fallback: string,
): string {
  if (o === undefined) return fallback;
  return o.display_name?.trim() || o.email || o.user_id;
}
export function initialsOf(name: string): string {
  const base = name.includes('@') ? name.slice(0, name.indexOf('@')) : name;
  const parts = base.split(/[\s._-]+/).filter(Boolean);
  const s = parts.length >= 2 ? `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}` : base.slice(0, 2);
  return s.toUpperCase() || '?';
}

// ---- role changes (handoff §5.8, §3.3) ------------------------------------------------------

export interface RoleChangePlan {
  readonly grants: string[];
  readonly revokes: string[];
  /** The last-owner refusal (handoff §3.3), or null. */
  readonly refusal: string | null;
}

/** One ROLE_GRANT / ROLE_REVOKE per toggled role (A9: one role per request). */
export function planRoleChange(
  subject: RosterOperator,
  name: string,
  next: readonly string[],
): RoleChangePlan {
  const cur = subject.commercial_role_keys;
  const grants = COMMERCIAL_ROLES.filter((r) => next.includes(r) && !cur.includes(r));
  const revokes = COMMERCIAL_ROLES.filter((r) => cur.includes(r) && !next.includes(r));
  const refusal =
    subject.is_last_owner && revokes.includes('platform_owner')
      ? `Refused: ${name} is the last Platform owner. Grant Platform owner to another person first, then remove it here.`
      : null;
  return { grants, revokes, refusal };
}

export const rolesText = (keys: readonly string[]): string =>
  keys.length === 0 ? 'No commercial roles' : keys.map(roleLabel).join(', ');

// ---- audit (handoff §5.7) -----------------------------------------------------------------

export const EVENT_LABEL: Readonly<Record<string, string>> = {
  COMMERCIAL_CHANGE_REQUEST_CREATED: 'Change request drafted',
  COMMERCIAL_CHANGE_REQUEST_SUBMITTED: 'Change request submitted',
  COMMERCIAL_APPROVAL_RECORDED: 'Approval step signed',
  COMMERCIAL_CHANGE_REQUEST_APPROVED: 'Change request approved',
  COMMERCIAL_CHANGE_REQUEST_REJECTED: 'Change request rejected',
  COMMERCIAL_CHANGE_REQUEST_EXPIRED: 'Change request expired',
  COMMERCIAL_CHANGE_REQUEST_WITHDRAWN: 'Change request withdrawn',
  COMMERCIAL_CHANGE_REQUEST_APPLIED: 'Change applied',
  COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED: 'Apply refused',
  COMMERCIAL_APPROVAL_REFUSED: 'Approval refused',
  COMMERCIAL_REJECTION_REFUSED: 'Rejection refused',
  COMMERCIAL_AUDIT_EXPORTED: 'Audit exported',
  COMMERCIAL_POLICY_VERSION_ACTIVATED: 'Policy version activated',
  COMMERCIAL_POLICY_VERSION_DRAFTED: 'Policy version drafted',
  COMMERCIAL_POLICY_DRAFT_UPDATED: 'Policy draft edited',
  COMMERCIAL_OPERATOR_ATTESTATION_RECORDED: 'Operator attested',
  COMMERCIAL_OPERATOR_ATTESTATION_REVOKED: 'Operator attestation revoked',
  COMMERCIAL_PLATFORM_OWNER_BOOTSTRAPPED: 'Platform owner bootstrapped',
};

/** A known label, else the code in sentence case ("SUPPORT_EXTENSION_APPLIED" → "Support extension applied"). */
export function eventLabel(code: string): string {
  const k = EVENT_LABEL[code];
  if (k !== undefined) return k;
  const w = code
    .replace(/^COMMERCIAL_/, '')
    .toLowerCase()
    .replace(/_/g, ' ');
  return w.charAt(0).toUpperCase() + w.slice(1);
}

export const PRODUCT_LABEL: Readonly<Record<string, string>> = {
  sign: 'Aramo Sign',
  ats: 'ATS',
  portal: 'Portal',
  intelligence: 'Intelligence',
};

const ACTION_LABEL: Readonly<Record<string, string>> = {
  SUBSCRIPTION_OPEN: 'Open subscription',
  SUBSCRIPTION_CHANGE: 'Plan change',
  SUBSCRIPTION_END: 'Cancel subscription',
  ENTITLEMENT_GRANT: 'Grant product',
  ENTITLEMENT_REVOKE: 'Revoke product',
  PLAN_VERSION_PUBLISH: 'Publish plan version',
  PLAN_RETIRE: 'Retire plan version',
  POLICY_ACTIVATE: 'Activate policy version',
  SUPPORT_EXTENSION: 'Support extension',
  ROLE_GRANT: 'Role grant',
  ROLE_REVOKE: 'Role removal',
  CREDIT: 'Account credit',
  DISCOUNT: 'Discount',
  CONVERSION: 'Conversion',
};

/** The Detail cell: a short reading of the structured payload (the record holds no free text). */
export function eventDetail(
  e: Pick<AuditEvent, 'event_type' | 'payload'>,
  names: (userId: string) => string,
): string {
  const p = e.payload;
  const action =
    typeof p['action_type'] === 'string'
      ? (ACTION_LABEL[p['action_type'] as string] ?? (p['action_type'] as string))
      : null;
  switch (e.event_type) {
    case 'COMMERCIAL_APPROVAL_RECORDED':
      return `${STEP_LABEL[String(p['step_role_key'])] ?? 'Approval'} step signed`;
    case 'COMMERCIAL_APPROVAL_REFUSED':
    case 'COMMERCIAL_REJECTION_REFUSED':
      return `Refused: ${String(p['refusal'] ?? '')}`;
    case 'COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED':
      return `Not applied: ${String(p['reason'] ?? '')}`;
    case 'COMMERCIAL_CHANGE_REQUEST_REJECTED':
      return String(p['reason'] ?? 'Rejected');
    case 'COMMERCIAL_AUDIT_EXPORTED':
      return `${String(p['row_count'] ?? 0)} events exported as CSV`;
    case 'COMMERCIAL_POLICY_VERSION_ACTIVATED':
      return `Policy v${String(p['version_number'] ?? '?')} active${p['rollback'] === true ? ' (rollback)' : ''}`;
    case 'COMMERCIAL_POLICY_VERSION_DRAFTED':
      return `Policy v${String(p['version_number'] ?? '?')} drafted from v${String(p['source_version_number'] ?? '?')}`;
    case 'COMMERCIAL_POLICY_DRAFT_UPDATED':
      return `Policy v${String(p['version_number'] ?? '?')}: ${Array.isArray(p['changed_keys']) ? (p['changed_keys'] as string[]).length : 0} setting(s) changed`;
    case 'COMMERCIAL_CHANGE_REQUEST_APPLIED':
      if (typeof p['subject_user_id'] === 'string')
        return `${p['change'] === 'REVOKE' ? 'Removed' : 'Granted'} ${roleLabel(String(p['role_key']))} ${p['change'] === 'REVOKE' ? 'from' : 'to'} ${names(p['subject_user_id'])}`;
      if (p['change'] === 'POLICY_ACTIVATE')
        return `Policy v${String(p['to_version_number'] ?? '?')} activated; v${String(p['from_version_number'] ?? '?')} retired`;
      return action ?? 'Applied';
    default:
      return action ?? '';
  }
}

/** A change request id for display ("CR-" + the first 8 hex digits). */
export const shortRequestId = (uuid: string): string =>
  `CR-${uuid.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
/** An event id for display ("ev_" + the last 8 hex digits). */
export const shortEventId = (uuid: string): string => `ev_${uuid.replace(/-/g, '').slice(-8)}`;

/** Browser download of the server-built CSV. */
export function downloadCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export type { PolicyContent };
