// CCP-B1 — the pure model behind the Approvals inbox and the change-request drawer:
// labels, pills, chain progress, the eligibility verdict, the TTL countdown, the
// row summary and effect, the timeline and the bootstrap banner. Copy follows the
// pinned CCP-UI v1.0 handoff (§3.1, §4, §5.1, §5.2); every value it shows comes from
// the CCP-A3 / CCP-A9 routes. Where those routes carry no value (PLATFORM-UX-1 R-13)
// the model returns the designed empty value and the acceptance record lists the
// divergence.

import type { PillSpec, PlatformTone } from '../components';
import type { TimelineEvent } from '../components';
import { formatTimestamp, shortId } from '../components';

import type { ChangeRequest, ChangeRequestDetail } from './commercial-api';

const H = 3_600_000;
const D = 24 * H;

// ── roles, steps, products, types ─────────────────────────────────────────────

export const COMMERCIAL_ROLE_KEYS = [
  'platform_owner',
  'finance_admin',
  'commercial_ops',
  'catalog_manager',
  'support_admin',
  'read_only_auditor',
] as const;
export type CommercialRoleKey = (typeof COMMERCIAL_ROLE_KEYS)[number];

/** Handoff §3 role labels (ccp-data.js ROLE). */
export const COMMERCIAL_ROLE_LABEL: Readonly<Record<CommercialRoleKey, string>> = {
  platform_owner: 'Platform owner',
  finance_admin: 'Finance admin',
  commercial_ops: 'Commercial ops',
  catalog_manager: 'Catalog manager',
  support_admin: 'Support admin',
  read_only_auditor: 'Read-only auditor',
};

export function commercialRoleLabel(key: string): string {
  return (COMMERCIAL_ROLE_LABEL as Readonly<Record<string, string>>)[key] ?? key;
}

/** The short step name ("Finance", "Owner"). */
export function stepLabel(roleKey: string): string {
  if (roleKey === 'finance_admin') return 'Finance';
  if (roleKey === 'platform_owner') return 'Owner';
  return commercialRoleLabel(roleKey);
}

export const PRODUCT_LABEL: Readonly<Record<string, string>> = { sign: 'Aramo Sign' };

export function productLabel(key: string | null): string {
  if (key === null) return '—';
  return PRODUCT_LABEL[key] ?? key;
}

/** Human label of each A3 action type (handoff ccp-data.js TYPE, nearest real action). */
export const ACTION_LABEL: Readonly<Record<string, string>> = {
  SUBSCRIPTION_OPEN: 'Open subscription',
  SUBSCRIPTION_CHANGE: 'Plan change',
  SUBSCRIPTION_END: 'Cancel subscription',
  ENTITLEMENT_GRANT: 'Grant product',
  ENTITLEMENT_REVOKE: 'Revoke product',
  PLAN_VERSION_PUBLISH: 'Publish plan version',
  PLAN_RETIRE: 'Retire plan version',
  POLICY_ACTIVATE: 'Activate policy version',
  SUPPORT_EXTENSION: 'Support extension',
  ROLE_GRANT: 'Role change',
  ROLE_REVOKE: 'Role change',
  CREDIT: 'Account credit',
  DISCOUNT: 'Discount',
  CONVERSION: 'Subscription conversion',
};

export function actionLabel(type: string): string {
  return ACTION_LABEL[type] ?? type;
}

// ── states ────────────────────────────────────────────────────────────────────

/** Handoff §4 state → label + tone. */
export const STATE_PILL: Readonly<Record<string, PillSpec>> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  PENDING_APPROVAL: { label: 'Pending approval', tone: 'info' },
  APPROVED: { label: 'Approved', tone: 'info' },
  APPLYING: { label: 'Applying', tone: 'info' },
  APPLIED: { label: 'Applied', tone: 'ok' },
  APPLY_FAILED: { label: 'Apply failed', tone: 'danger' },
  REJECTED: { label: 'Rejected', tone: 'muted' },
  EXPIRED: { label: 'Expired', tone: 'muted' },
  WITHDRAWN: { label: 'Withdrawn', tone: 'muted' },
};

export function statePill(state: string): PillSpec {
  return STATE_PILL[state] ?? { label: state, tone: 'neutral' as PlatformTone };
}

export const isPending = (r: Pick<ChangeRequest, 'state'>): boolean => r.state === 'PENDING_APPROVAL';

// ── time ─────────────────────────────────────────────────────────────────────

const ms = (iso: string | null | undefined): number | null => {
  if (iso === null || iso === undefined) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/** The design's hour-granular relative time (ccp-data.js `rel`): "5 h ago", "12 min ago", "3 d ago", "in 2 h". */
export function relativeShort(iso: string | null | undefined, now: Date): string {
  const t = ms(iso);
  if (t === null) return '';
  const df = now.getTime() - t;
  const a = Math.abs(df);
  const f = a < H ? `${Math.max(1, Math.round(a / 60_000))} min` : a < 2 * D ? `${Math.round(a / H)} h` : `${Math.round(a / D)} d`;
  return df >= 0 ? `${f} ago` : `in ${f}`;
}

/** Whole hours left in the approval window (rounded, as the design), or null. */
export function hoursLeft(r: Pick<ChangeRequest, 'expires_at'>, now: Date): number | null {
  const t = ms(r.expires_at);
  return t === null ? null : Math.round((t - now.getTime()) / H);
}

export type ExpiresTone = 'ink' | 'warn' | 'danger';

/** The inbox "Expires" cell (handoff §4 TTL). */
export function expiresCell(r: ChangeRequest, now: Date): { readonly text: string; readonly tone: ExpiresTone } {
  if (isPending(r)) {
    const h = hoursLeft(r, now);
    if (h === null) return { text: '—', tone: 'ink' };
    return { text: `${Math.max(0, h)} h left`, tone: h < 12 ? 'warn' : 'ink' };
  }
  if (r.state === 'DRAFT') return { text: 'Not submitted', tone: 'ink' };
  if (r.state === 'EXPIRED') return { text: `Expired ${relativeShort(r.expires_at ?? r.expired_at, now)}`, tone: 'danger' };
  return { text: '—', tone: 'ink' };
}

/** The drawer "Approval window" fact. */
export function approvalWindow(r: ChangeRequest, now: Date): { readonly text: string; readonly tone: ExpiresTone } {
  if (isPending(r)) {
    const h = hoursLeft(r, now);
    return { text: `Expires ${formatTimestamp(r.expires_at)} · ${Math.max(0, h ?? 0)} h left`, tone: 'ink' };
  }
  if (r.state === 'EXPIRED') return { text: `Expired ${formatTimestamp(r.expires_at ?? r.expired_at)}`, tone: 'danger' };
  if (r.state === 'DRAFT') return { text: 'Starts when submitted', tone: 'ink' };
  return { text: 'Closed', tone: 'ink' };
}

/** The window length the request's own policy gave it ("72 h"), or null before submit. */
export function windowHours(r: ChangeRequest): number | null {
  const s = ms(r.submitted_at);
  const e = ms(r.expires_at);
  return s === null || e === null ? null : Math.round((e - s) / H);
}

// ── chains ────────────────────────────────────────────────────────────────────

/** The handoff §3 chain name for a request's snapshotted chain. */
export function chainName(r: Pick<ChangeRequest, 'action_type' | 'required_chain'>): string {
  const rule = r.required_chain.rule;
  if (rule === 'DISTINCT_PLATFORM_OWNER') return 'Role change (privileged)';
  if (r.action_type === 'POLICY_ACTIVATE') return 'Policy change';
  if (r.action_type === 'PLAN_VERSION_PUBLISH' || r.action_type === 'PLAN_RETIRE') return 'Catalog publish';
  if (rule === 'FINANCE_THEN_OWNER') return 'Above threshold';
  return 'Below threshold';
}

/** "Finance → Owner". */
export function chainSteps(r: Pick<ChangeRequest, 'required_chain'>): string {
  return r.required_chain.steps.map((s) => stepLabel(s.role_key)).join(' → ');
}

/** "Above threshold: Finance → Owner". */
export function chainSummary(r: Pick<ChangeRequest, 'action_type' | 'required_chain'>): string {
  return `${chainName(r)}: ${chainSteps(r)}`;
}

export interface ChainMark {
  readonly label: string;
  readonly signed: boolean;
}

/**
 * The inbox chain progress ("Finance ✓ › Owner ○"). Signed steps come from the
 * detail's approvals; without a detail, the state decides (approved and later =
 * every step signed; anything else = none known).
 */
export function chainMarks(r: ChangeRequest, detail: ChangeRequestDetail | null | undefined): ChainMark[] {
  const signed = new Set<number>();
  if (detail) for (const a of detail.approvals) signed.add(a.step_index);
  else if (['APPROVED', 'APPLYING', 'APPLIED', 'APPLY_FAILED'].includes(r.state)) for (const s of r.required_chain.steps) signed.add(s.step_index);
  return r.required_chain.steps.map((s) => ({ label: stepLabel(s.role_key), signed: signed.has(s.step_index) }));
}

/** The next unsigned step of a pending request, or null. */
export function nextStep(detail: ChangeRequestDetail): ChangeRequestDetail['steps'][number] | null {
  return detail.steps.find((s) => s.status === 'NEXT') ?? null;
}

// ── eligibility (handoff §3.1) ───────────────────────────────────────────────

export type VerdictCode = 'OK' | 'NOT_PENDING' | 'EXPIRED' | 'NOT_HUMAN' | 'SELF_APPROVAL' | 'USER_ALREADY_APPROVED' | 'STEP_SCOPE_MISSING' | 'OUT_OF_ORDER';

export interface Verdict {
  readonly code: VerdictCode;
  readonly label: string;
  readonly why: string;
  /** The step the verdict is about (index), when there is one. */
  readonly stepIndex: number | null;
}

/** The design label of each refusal (handoff §3.1 "Label"). */
export const REFUSAL_LABEL: Readonly<Record<Exclude<VerdictCode, 'OK'>, string>> = {
  NOT_PENDING: 'Not pending',
  EXPIRED: 'Expired',
  NOT_HUMAN: 'Not a human actor',
  SELF_APPROVAL: 'You requested this',
  USER_ALREADY_APPROVED: 'You already approved a step',
  STEP_SCOPE_MISSING: 'Missing the scope for this step',
  OUT_OF_ORDER: 'Out of order',
};

export interface VerdictContext {
  /** The signed-in operator's user id (the session subject). */
  readonly meId: string;
  readonly now: Date;
}

/** One refusal → the design's label and why line. */
export function refusalVerdict(code: string, detail: ChangeRequestDetail, ctx: VerdictContext): Verdict {
  const r = detail.request;
  const step = nextStep(detail);
  const stepName = step ? stepLabel(step.role_key) : 'next';
  const stepIndex = step ? step.step_index : null;
  switch (code) {
    case 'NOT_PENDING':
      return { code, label: REFUSAL_LABEL.NOT_PENDING, why: `This request is ${statePill(r.state).label.toLowerCase()}.`, stepIndex };
    case 'EXPIRED':
      return { code, label: REFUSAL_LABEL.EXPIRED, why: `The approval window closed ${relativeShort(r.expires_at, ctx.now)}.`, stepIndex };
    case 'NOT_HUMAN':
      return { code, label: REFUSAL_LABEL.NOT_HUMAN, why: 'Approval steps are signed only by attested people. Service accounts can’t sign them.', stepIndex };
    case 'SELF_APPROVAL': {
      const subject = r.payload['subject_user_id'];
      const isSubject = typeof subject === 'string' && subject === ctx.meId && r.requested_by !== ctx.meId;
      return {
        code,
        label: REFUSAL_LABEL.SELF_APPROVAL,
        why: isSubject ? 'A role change can’t be approved by the person it changes.' : 'The person who made a request can’t approve it.',
        stepIndex,
      };
    }
    case 'USER_ALREADY_APPROVED':
      return { code, label: REFUSAL_LABEL.USER_ALREADY_APPROVED, why: 'One person can sign only one step, even when they hold two roles.', stepIndex };
    case 'OUT_OF_ORDER':
      return { code, label: REFUSAL_LABEL.OUT_OF_ORDER, why: `The ${stepName} step must be signed first.`, stepIndex };
    case 'STEP_SCOPE_MISSING':
    default:
      return {
        code: 'STEP_SCOPE_MISSING',
        label: REFUSAL_LABEL.STEP_SCOPE_MISSING,
        why: step ? `The ${stepName} step needs the ${commercialRoleLabel(step.role_key)} role.` : 'Your roles don’t cover this step.',
        stepIndex,
      };
  }
}

/**
 * The caller's verdict on a request (handoff §3.1, first match wins): the request
 * state, the window, then the server's own per-step verdict for the next step
 * (`steps[].caller`, evaluated live by the A3 engine). The UI never computes an
 * approval on its own; it only explains the engine's answer.
 */
export function verdictFor(detail: ChangeRequestDetail, ctx: VerdictContext): Verdict {
  const r = detail.request;
  if (!isPending(r)) return refusalVerdict('NOT_PENDING', detail, ctx);
  if (detail.is_expired) return refusalVerdict('EXPIRED', detail, ctx);
  const step = nextStep(detail);
  if (step === null || step.caller === null) return refusalVerdict('NOT_PENDING', detail, ctx);
  if (step.caller.eligible) {
    return {
      code: 'OK',
      label: `You can sign the ${stepLabel(step.role_key)} step`,
      why: 'Approving records your name and current roles in the audit log.',
      stepIndex: step.step_index,
    };
  }
  return refusalVerdict(step.caller.refusal ?? 'STEP_SCOPE_MISSING', detail, ctx);
}

// ── people ───────────────────────────────────────────────────────────────────

export interface Me {
  readonly id: string;
  /** Display name or email, when /platform/me resolved. */
  readonly name: string | null;
}

/**
 * A person on a request. The A3 routes carry user ids only (R-13): the caller is
 * named from /platform/me, anyone else is their short id.
 */
export function personLabel(userId: string, me: Me): string {
  if (userId === me.id) return me.name ?? 'you';
  return shortId(userId);
}

// ── summaries and effect ─────────────────────────────────────────────────────

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** "$350" · "$350.50" (USD, design `money`) · "350.00 EUR". */
export function money(amountMinor: number, currency: string): string {
  const major = amountMinor / 100;
  if (currency === 'USD') return `$${major.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  return `${major.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

/**
 * CCP-R3 (Aramo-CCP-A1-Amendment-A1-Finance-Amount-Scope-v1_0, LOCKED; FA-5): the server omits a
 * tenant-specific amount for a caller without platform:billing:amount:read and sends
 * `amount_withheld: "FINANCE_SCOPE_REQUIRED"` instead. The console shows this state; it never has
 * a figure to hide. Holders (platform_owner, finance_admin, read_only_auditor) see the amount.
 */
export const AMOUNT_WITHHELD_LABEL = 'withheld — Finance amount access required';

export function amountWithheld(p: Record<string, unknown>): boolean {
  return typeof p['amount_withheld'] === 'string';
}

/** "25%" from basis points. */
export function percent(bps: number): string {
  return `${(bps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
}

/** The one-line change summary (inbox "Change" column, drawer title). */
export function summaryOf(r: ChangeRequest, me: Me): string {
  const p = r.payload;
  switch (r.action_type) {
    case 'CREDIT': {
      if (amountWithheld(p)) return `Amount ${AMOUNT_WITHHELD_LABEL}`;
      const a = num(p['amount_minor']);
      const c = typeof p['currency'] === 'string' ? p['currency'] : 'USD';
      return a === null ? 'Account credit' : `${money(a, c)} account credit`;
    }
    case 'DISCOUNT': {
      const b = num(p['discount_bps']);
      return b === null ? 'Discount' : `${percent(b)} discount`;
    }
    case 'SUPPORT_EXTENSION': {
      const d = num(p['requested_days']);
      return d === null ? 'Support extension (escalated)' : `+${d} day support extension (escalated)`;
    }
    case 'ROLE_GRANT':
    case 'ROLE_REVOKE': {
      const role = commercialRoleLabel(String(p['role_key'] ?? ''));
      const who = typeof p['subject_user_id'] === 'string' ? personLabel(p['subject_user_id'], me) : 'an operator';
      return r.action_type === 'ROLE_GRANT' ? `Grant ${role} to ${who}` : `Remove ${role} from ${who}`;
    }
    case 'POLICY_ACTIVATE':
      return 'Activate a commercial policy version';
    case 'PLAN_VERSION_PUBLISH':
      return 'Publish a plan version';
    case 'PLAN_RETIRE':
      return 'Retire a plan version';
    default:
      return `${actionLabel(r.action_type)} · ${productLabel(r.product_key)}`;
  }
}

/** One effect row: field, before (struck), after. `null` before = not carried by the request. */
export interface EffectRow {
  readonly field: string;
  readonly before: string | null;
  readonly after: string;
}

/**
 * The effect, before → after (handoff §5.2 item 4). A change request carries the
 * requested change (the after side); the current value is not part of it until the
 * applying slices (A6 / B3) expose it, so `before` is null (rendered "—") except
 * where the request itself fixes it (a role grant / revoke).
 */
export function effectRows(r: ChangeRequest, me: Me): EffectRow[] {
  const p = r.payload;
  switch (r.action_type) {
    case 'CREDIT': {
      if (amountWithheld(p)) return [{ field: 'Account credit', before: null, after: `Amount ${AMOUNT_WITHHELD_LABEL}` }];
      const a = num(p['amount_minor']);
      const c = typeof p['currency'] === 'string' ? p['currency'] : 'USD';
      return [{ field: 'Account credit', before: null, after: a === null ? '—' : money(a, c) }];
    }
    case 'DISCOUNT': {
      const b = num(p['discount_bps']);
      return [{ field: 'Discount', before: null, after: b === null ? '—' : percent(b) }];
    }
    case 'SUPPORT_EXTENSION': {
      const d = num(p['requested_days']);
      return [{ field: 'Support extension', before: null, after: d === null ? '—' : `+${d} days` }];
    }
    case 'ROLE_GRANT':
    case 'ROLE_REVOKE': {
      const role = commercialRoleLabel(String(p['role_key'] ?? ''));
      const who = typeof p['subject_user_id'] === 'string' ? personLabel(p['subject_user_id'], me) : 'Operator';
      const grant = r.action_type === 'ROLE_GRANT';
      return [{ field: `${who} · ${role}`, before: grant ? 'Not held' : 'Held', after: grant ? 'Held' : 'Not held' }];
    }
    case 'POLICY_ACTIVATE':
      return [{ field: 'Active commercial policy', before: null, after: typeof p['policy_version_id'] === 'string' ? shortId(p['policy_version_id']) : '—' }];
    default:
      return [{ field: actionLabel(r.action_type), before: null, after: productLabel(r.product_key) }];
  }
}

// ── the inbox tabs (handoff §5.1) ────────────────────────────────────────────

export type InboxTab = 'me' | 'pending' | 'mine' | 'history';
export const INBOX_TABS: readonly InboxTab[] = ['me', 'pending', 'mine', 'history'];

export const TAB_LABEL: Readonly<Record<InboxTab, string>> = {
  me: 'Waiting on me',
  pending: 'All pending',
  mine: 'Requested by me',
  history: 'History',
};

export const TAB_EMPTY: Readonly<Record<InboxTab, { readonly title: string; readonly body: string }>> = {
  me: { title: 'Nothing waiting on you', body: 'Requests appear here when you can sign their current step.' },
  pending: { title: 'No pending requests', body: 'New change requests appear here until every step is signed.' },
  mine: { title: 'You haven’t made any requests', body: 'Requests you create from tenants, the catalog, policy or roles appear here.' },
  history: { title: 'No history yet', body: 'Applied, rejected, expired and withdrawn requests appear here.' },
};

/** The rows of a tab. "Waiting on me" is the server's `eligible_for_me` set (live verdict). */
export function tabRows(tab: InboxTab, all: readonly ChangeRequest[], eligibleIds: ReadonlySet<string>, meId: string): ChangeRequest[] {
  switch (tab) {
    case 'me':
      return all.filter((r) => isPending(r) && eligibleIds.has(r.id));
    case 'pending':
      return all.filter(isPending);
    case 'mine':
      return all.filter((r) => r.requested_by === meId);
    case 'history':
      return all.filter((r) => !isPending(r) && r.state !== 'DRAFT');
  }
}

/** Pending rows by soonest expiry, the rest newest first (handoff §5.1 "Sort"; design comparator). */
export function sortRows(rows: readonly ChangeRequest[]): ChangeRequest[] {
  const exp = (r: ChangeRequest) => ms(r.expires_at) ?? Number.MAX_SAFE_INTEGER;
  const created = (r: ChangeRequest) => ms(r.created_at) ?? 0;
  return [...rows].sort((a, b) => (isPending(a) && isPending(b) ? exp(a) - exp(b) : created(b) - created(a)));
}

// ── bootstrap banner (handoff §3.2) ──────────────────────────────────────────

/**
 * The chains named by the banner: every loaded pending request whose chain the A3
 * gate reports as not fulfillable (`chain_satisfiable === false`), plus any chain a
 * 409 `CCP_NOT_BOOTSTRAPPED` just refused. "Above threshold (Finance → Owner)".
 */
export function unfulfillableChains(details: readonly ChangeRequestDetail[], refused: readonly ChangeRequest[] = []): string[] {
  const out = new Map<string, string>();
  const add = (r: ChangeRequest): void => {
    out.set(chainName(r), `${chainName(r)} (${chainSteps(r)})`);
  };
  for (const d of details) if (isPending(d.request) && d.chain_satisfiable === false) add(d.request);
  for (const r of refused) add(r);
  // The handoff §3 chain order, whatever order the reads completed in.
  return CHAIN_ORDER.filter((n) => out.has(n)).map((n) => out.get(n) as string);
}

/** Handoff §3 "Approval chains" order. */
export const CHAIN_ORDER: readonly string[] = ['Above threshold', 'Below threshold', 'Catalog publish', 'Role change (privileged)', 'Policy change'];

// ── the request-state stepper (handoff §4, CrStepper) ────────────────────────

export type StepMark = 'done' | 'current' | 'todo' | 'failed' | 'terminal';

export interface StateStep {
  readonly label: string;
  readonly mark: StepMark;
  /** Dimmed (45%) — a chip after a terminal state. */
  readonly dim: boolean;
}

const MAIN: readonly string[] = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'APPLYING', 'APPLIED'];
const REACH: Readonly<Record<string, number>> = {
  DRAFT: 0,
  PENDING_APPROVAL: 1,
  APPROVED: 2,
  APPLYING: 3,
  APPLIED: 4,
  APPLY_FAILED: 3,
  REJECTED: 1,
  EXPIRED: 1,
  WITHDRAWN: 1,
};
const TERMINAL = ['REJECTED', 'EXPIRED', 'WITHDRAWN', 'APPLY_FAILED'];

/**
 * CCP-C4 — the Stripe-side request types: their Applying chip reads "Sent to Stripe — awaiting
 * confirmation" (handoff §4 "While a Stripe-side request is Applying …"; Conversion Rule C-23: never
 * reported done before the provider confirms). A credit, discount or refund in APPLYING is always
 * pending at the provider (it commits in APPLYING only with its durable command).
 */
export const STRIPE_SIDE_ACTIONS: readonly string[] = ['CREDIT', 'DISCOUNT', 'REFUND'];
export const STRIPE_SENT_LABEL = 'Sent to Stripe — awaiting confirmation';

/** The design's stepper model (Commercial Control Plane v1.0.dc.html, drawer `stepper`). */
export function stateSteps(state: string, actionType?: string): StateStep[] {
  const stripeSent = state === 'APPLYING' && actionType !== undefined && STRIPE_SIDE_ACTIONS.includes(actionType);
  const reach = REACH[state] ?? 0;
  const term = TERMINAL.includes(state);
  // A request withdrawn while still a draft never reached Pending approval.
  const steps: StateStep[] = MAIN.map((k, i) => {
    const done = i < reach || (k === 'APPLIED' && state === 'APPLIED');
    const failed = term && i === reach;
    const current = !term && i === reach && !done;
    return {
      label: k === 'APPLYING' && stripeSent ? STRIPE_SENT_LABEL : statePill(k).label,
      mark: done ? 'done' : failed ? 'failed' : current ? 'current' : 'todo',
      dim: term && i > reach,
    };
  });
  if (term) steps.push({ label: statePill(state).label, mark: 'terminal', dim: false });
  return steps;
}

// ── timeline (handoff §5.2 item 10) ──────────────────────────────────────────

/** Submitted, steps signed, the terminal event — newest first. */
export function timelineOf(detail: ChangeRequestDetail, me: Me): TimelineEvent[] {
  const r = detail.request;
  const ev: TimelineEvent[] = [];
  const requester = { label: r.requested_by === me.id ? (me.name ?? 'You') : 'Requester', id: r.requested_by };
  if (r.submitted_at) ev.push({ id: 'submitted', label: 'Submitted for approval', at: r.submitted_at, tone: 'info', actor: requester });
  else ev.push({ id: 'drafted', label: 'Draft saved', at: r.created_at, tone: 'neutral', actor: requester });
  for (const a of detail.approvals) {
    ev.push({
      id: `approval-${a.id}`,
      label: `${stepLabel(a.step_role_key)} step signed`,
      at: a.created_at,
      tone: 'ok',
      actor: { label: a.approver_user_id === me.id ? `${me.name ?? 'You'} · as ${commercialRoleLabel(a.step_role_key)}` : `As ${commercialRoleLabel(a.step_role_key)}`, id: a.approver_user_id },
      note: a.comment ?? undefined,
    });
  }
  if (r.approved_at) ev.push({ id: 'approved', label: 'Approved', at: r.approved_at, tone: 'info', actor: { label: 'System' } });
  if (r.applied_at) ev.push({ id: 'applied', label: 'Applied', at: r.applied_at, tone: 'ok', actor: { label: 'System' } });
  if (r.rejected_at) {
    ev.push({
      id: 'rejected',
      label: 'Rejected',
      at: r.rejected_at,
      tone: 'danger',
      actor: { label: r.rejected_by === me.id ? (me.name ?? 'You') : 'Approver', id: r.rejected_by },
      note: r.rejection_reason ?? undefined,
    });
  }
  if (r.withdrawn_at) ev.push({ id: 'withdrawn', label: 'Withdrawn', at: r.withdrawn_at, tone: 'muted', actor: requester });
  if (r.expired_at) ev.push({ id: 'expired', label: 'Expired', at: r.expired_at, tone: 'muted', actor: { label: 'System' } });
  return ev.sort((a, b) => (ms(b.at) ?? 0) - (ms(a.at) ?? 0));
}

/** The short reference shown in the table ("0f3a91c…"); the full id is in the drawer. */
export function requestRef(id: string): string {
  return shortId(id);
}
