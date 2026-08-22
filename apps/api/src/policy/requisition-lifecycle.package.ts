import type { Decision, PolicyPackage } from '@aramo/policy-engine';
import { REQUISITION_LIFECYCLE_PACKAGE_NAME } from '@aramo/pipeline';
import {
  TRANSITION_ACTIONS,
  REQUISITION_RESOURCE,
  type TransitionAction,
} from '@aramo/requisition';

// The requisition-lifecycle policy package — DATA (ADR-0024 §D2). This is the
// SEED payload, not runtime code: published to policy-store (through
// PolicyStore.publish → validatePackage → real version + checksum) and the
// consumer retrieves it at decision time. It lives in the composition layer
// (apps/api) because authoring an ATS-domain policy is an ATS concern;
// libs/policy-store stays domain-agnostic and never imports it.
//
// T1-d — version 4.0.0, re-keyed on the RecruitingStatus enum (the DATA that
// supersedes RequisitionStatus). The MATRIX table below IS the policy; the
// engine reads it generically. NO rule is expressed in engine code (§D2). The
// value crosswalk (PO ruling): former `active` -> `open`, former `full` ->
// `submittals_closed`; `lead` retained. Prior versions (the permissive 1.0.0
// and the restrictive 3.0.0) stay in the store with their windows closed;
// earlier provenance still names the version it was decided under (§D17b).
//
// draft / pending_approval are now REACHABLE (Approval sub-workflow, Amendment B)
// but PRE-OPEN; archived remains subsystem-gated (unreachable until retention
// ships). All three carry an EXPLICIT DENY-everything-except-Note row: no
// talent/submittal/document work before a requisition is open, and a permissive
// default on these states would be a foothold, so we fail closed. Note stays
// ALLOW (compliance documentation must never be blocked). SET_PRIORITY is DENY.
//
// `submittals_closed` gates on DECLARATION — "the owner declared submittals
// closed" — NEVER on capacity (§D13). openings_available is not yet truthful; a
// capacity-keyed rule is Track 4, prohibited here. Note = ALLOW in EVERY state
// (incl. closed/canceled): compliance documentation on a terminal requisition
// must remain possible — denying it drives off-system records.
//
// ADR ERRATUM: ADR-0024's Submit resource + override-capability identifiers use
// a Tier-2-banned trust-vocabulary token (scripts/verify-vocabulary.sh), so the
// ADR's own identifiers fail CI. The canonical PR-4b forms are used instead:
// `REQUISITION_SUBMITTAL` and `requisition.override.submittal_closed`.

// The engine-named override capability all REQUIRES_OVERRIDE rows require (§D11).
const OVERRIDE_CAP = 'requisition.override.submittal_closed';

// The four governed command surfaces (resource · action per §D5). Each column
// key drives one resource/action and a stable rule-id prefix + reason prefix.
const COLUMNS = [
  { key: 'add', resource: 'REQUISITION_TALENT', action: 'ADD', idPrefix: 'add-talent', reason: 'ADD' },
  { key: 'submit', resource: 'REQUISITION_SUBMITTAL', action: 'CREATE', idPrefix: 'submit', reason: 'SUBMIT' },
  { key: 'note', resource: 'REQUISITION_NOTE', action: 'ADD', idPrefix: 'note', reason: 'NOTE' },
  { key: 'document', resource: 'REQUISITION_DOCUMENT', action: 'ADD', idPrefix: 'document', reason: 'DOCUMENT' },
] as const;

type ColumnKey = (typeof COLUMNS)[number]['key'];

// THE MATRIX (§D13) — the authored DATA. One decision per (state, column).
const MATRIX: Readonly<Record<string, Readonly<Record<ColumnKey, Decision>>>> = {
  open: { add: 'ALLOW', submit: 'ALLOW', note: 'ALLOW', document: 'ALLOW' },
  on_hold: { add: 'ALLOW', submit: 'DENY', note: 'ALLOW', document: 'ALLOW' },
  submittals_closed: { add: 'REQUIRES_OVERRIDE', submit: 'REQUIRES_OVERRIDE', note: 'ALLOW', document: 'REQUIRES_OVERRIDE' },
  closed: { add: 'DENY', submit: 'DENY', note: 'ALLOW', document: 'DENY' },
  canceled: { add: 'DENY', submit: 'DENY', note: 'ALLOW', document: 'DENY' },
  lead: { add: 'ALLOW', submit: 'DENY', note: 'ALLOW', document: 'ALLOW' },
  // draft / pending_approval — reachable via the Approval sub-workflow but PRE-OPEN:
  // no talent/submittal/document work until APPROVED → open. Fail closed on
  // everything but Note (compliance documentation is never blocked). archived
  // stays subsystem-gated (unreachable until retention ships), same posture.
  draft: { add: 'DENY', submit: 'DENY', note: 'ALLOW', document: 'DENY' },
  pending_approval: { add: 'DENY', submit: 'DENY', note: 'ALLOW', document: 'DENY' },
  archived: { add: 'DENY', submit: 'DENY', note: 'ALLOW', document: 'DENY' },
};

const REASON_SUFFIX: Readonly<Record<Decision, string>> = {
  ALLOW: 'ALLOWED',
  ALLOW_WITH_AUDIT: 'ALLOWED',
  DENY: 'DENIED',
  REQUIRES_OVERRIDE: 'OVERRIDE_REQUIRED',
};

// Serialize the MATRIX table into engine rules. This is data marshalling, not
// rule logic: every rule keys on the declared status and carries the table's
// decision; REQUIRES_OVERRIDE rows name the capability + require a reason.
const RULES: PolicyPackage['rules'] = Object.entries(MATRIX).flatMap(([status, row]) =>
  COLUMNS.map((col) => {
    const decision = row[col.key];
    const reason_code = `LIFECYCLE_${col.reason}_${REASON_SUFFIX[decision]}`;
    const base = {
      id: `${col.idPrefix}-${status}`,
      resource: col.resource,
      action: col.action,
      when: [{ source: 'declared' as const, key: 'status', op: 'eq' as const, value: status }],
      decision,
      reason_code,
    };
    return decision === 'REQUIRES_OVERRIDE'
      ? { ...base, required_capability: OVERRIDE_CAP, effects: [{ kind: 'REQUIRE_REASON' as const }] }
      : base;
  }),
);

// PR-7 — REQUISITION · SET_PRIORITY (the is_hot flag). Priority is a team-wide
// operational attribute; this governs WHEN it may be ASSERTED, keyed on the
// declared status. open/on_hold/submittals_closed/lead ALLOW; closed/canceled
// DENY (priority on a terminal requisition is meaningless). Clearing (is_hot →
// false) is NOT a governed operation — the caller evaluates SET_PRIORITY only
// when is_hot is being set TRUE (R3); "false" is never encoded as a rule.
const SET_PRIORITY_MATRIX: Readonly<Record<string, Decision>> = {
  open: 'ALLOW',
  on_hold: 'ALLOW',
  submittals_closed: 'ALLOW',
  closed: 'DENY',
  canceled: 'DENY',
  lead: 'ALLOW',
  // Pre-open (draft / pending_approval) + subsystem-gated (archived) — priority
  // is meaningless before a requisition is live; set it once open.
  draft: 'DENY',
  pending_approval: 'DENY',
  archived: 'DENY',
};
const SET_PRIORITY_RULES: PolicyPackage['rules'] = Object.entries(SET_PRIORITY_MATRIX).map(
  ([status, decision]) => ({
    id: `set-priority-${status}`,
    resource: 'REQUISITION',
    action: 'SET_PRIORITY',
    when: [{ source: 'declared' as const, key: 'status', op: 'eq' as const, value: status }],
    decision,
    reason_code: `LIFECYCLE_SET_PRIORITY_${REASON_SUFFIX[decision]}`,
  }),
);

// T1-e (§2.2 / §4 Q3) — the GOVERNED TRANSITIONS. Four distinct actions, each
// keyed on the requisition's declared FROM status (the SET_PRIORITY idiom): the
// destination is IMPLIED by the action (CLOSE→closed, REOPEN→open,
// PUT_ON_HOLD→on_hold, CANCEL→canceled), so a governed transition never needs a
// two-value (from,to) key. Policy EVALUATES may-this-fire; the domain EXECUTES
// (§D14). The action identifiers + resource are imported from @aramo/requisition
// so the DATA here and the domain service share ONE definition (no bare-literal
// port coupling — the T1-a lesson).
//
// The matrix is authored over ALL nine statuses even though several are
// same-value (won't fire at runtime) or gated (unreachable): the package
// default_disposition is ALLOW, so an UNLISTED (action, status) cell would
// silently ALLOW — every cell is explicit to make the transition policy
// auditable and fail-closed on terminal / gated FROM-states.
//   - Terminal FROM-states (closed / canceled) DENY every transition except the
//     legitimate REOPEN of a `closed` requisition; a `canceled` requisition is
//     dead (recreate, never reopen).
//   - The four ORIGINAL transitions DENY from draft / pending_approval (a
//     pre-open requisition is not closed/reopened/held/canceled — it moves
//     through the approval chain); archived DENYs all (still subsystem-gated).
//   - The Approval sub-workflow (Amendment B) adds SUBMIT_FOR_APPROVAL / APPROVE
//     / REJECT, each firing from exactly one from-status (draft / pending_approval
//     / pending_approval). APPROVE and REOPEN both land `open`, disambiguated by
//     the from-status (edge-keyed governingAction).
//   - `lead → open` is REOPEN = ALLOW (R5 — an ordinary recruiter action).
const TRANSITION_MATRIX: Readonly<Record<TransitionAction, Readonly<Record<string, Decision>>>> = {
  CLOSE: {
    lead: 'ALLOW', open: 'ALLOW', on_hold: 'ALLOW', submittals_closed: 'ALLOW',
    canceled: 'DENY', closed: 'DENY',
    draft: 'DENY', pending_approval: 'DENY', archived: 'DENY',
  },
  REOPEN: {
    lead: 'ALLOW', on_hold: 'ALLOW', submittals_closed: 'ALLOW', closed: 'ALLOW',
    open: 'DENY', canceled: 'DENY',
    draft: 'DENY', pending_approval: 'DENY', archived: 'DENY',
  },
  PUT_ON_HOLD: {
    lead: 'ALLOW', open: 'ALLOW', submittals_closed: 'ALLOW',
    on_hold: 'DENY', closed: 'DENY', canceled: 'DENY',
    draft: 'DENY', pending_approval: 'DENY', archived: 'DENY',
  },
  CANCEL: {
    lead: 'ALLOW', open: 'ALLOW', on_hold: 'ALLOW', submittals_closed: 'ALLOW',
    canceled: 'DENY', closed: 'DENY',
    draft: 'DENY', pending_approval: 'DENY', archived: 'DENY',
  },
  // Approval sub-workflow (Amendment B). Each approval action fires from EXACTLY
  // ONE from-status; every other from-status DENIES (fail-closed on the ALLOW
  // default). draft → pending_approval = SUBMIT_FOR_APPROVAL; pending_approval →
  // open = APPROVE; pending_approval → draft = REJECT.
  SUBMIT_FOR_APPROVAL: {
    draft: 'ALLOW',
    lead: 'DENY', open: 'DENY', on_hold: 'DENY', submittals_closed: 'DENY',
    closed: 'DENY', canceled: 'DENY', pending_approval: 'DENY', archived: 'DENY',
  },
  APPROVE: {
    pending_approval: 'ALLOW',
    lead: 'DENY', draft: 'DENY', open: 'DENY', on_hold: 'DENY',
    submittals_closed: 'DENY', closed: 'DENY', canceled: 'DENY', archived: 'DENY',
  },
  REJECT: {
    pending_approval: 'ALLOW',
    lead: 'DENY', draft: 'DENY', open: 'DENY', on_hold: 'DENY',
    submittals_closed: 'DENY', closed: 'DENY', canceled: 'DENY', archived: 'DENY',
  },
};

// Serialize the transition matrix into engine rules: one predicate per rule,
// keyed on the declared FROM status — identical marshalling to the column /
// SET_PRIORITY matrices above.
const TRANSITION_RULES: PolicyPackage['rules'] = TRANSITION_ACTIONS.flatMap((action) =>
  Object.entries(TRANSITION_MATRIX[action]).map(([status, decision]) => ({
    id: `transition-${action.toLowerCase()}-${status}`,
    resource: REQUISITION_RESOURCE,
    action,
    when: [{ source: 'declared' as const, key: 'status', op: 'eq' as const, value: status }],
    decision,
    reason_code: `LIFECYCLE_TRANSITION_${action}_${REASON_SUFFIX[decision]}`,
  })),
);

export const REQUISITION_LIFECYCLE_PACKAGE: PolicyPackage = {
  name: REQUISITION_LIFECYCLE_PACKAGE_NAME,
  // Approval sub-workflow (Amendment B) — version 6.0.0. New MAJOR: the three
  // approval-transition actions (SUBMIT_FOR_APPROVAL / APPROVE / REJECT) are a
  // new behavioural surface. v5.0.0 (the four T1-e transitions) and v4.0.0 stay
  // in the store, windows closed; earlier provenance still names the version it
  // was decided under when re-read from the DB (§D17b).
  version: '6.0.0',
  registry: {
    resources: [
      'REQUISITION_TALENT',
      'REQUISITION_SUBMITTAL',
      'REQUISITION_NOTE',
      'REQUISITION_DOCUMENT',
      'REQUISITION',
    ],
    // The seven governed-transition actions (T1-e's four + the Approval
    // sub-workflow's SUBMIT_FOR_APPROVAL / APPROVE / REJECT) join ADD/CREATE/
    // SET_PRIORITY. The engine REJECTS an unregistered action at evaluate time,
    // so they MUST be registered for the transition gate to resolve.
    actions: ['ADD', 'CREATE', 'SET_PRIORITY', ...TRANSITION_ACTIONS],
  },
  // R3 — a package MUST declare its own no-match disposition. ALLOW (permissive
  // by default; the matrix restricts the specific governed cells).
  default_disposition: {
    decision: 'ALLOW',
    reason_code: 'LIFECYCLE_ALLOWED_DEFAULT',
  },
  rules: [...RULES, ...SET_PRIORITY_RULES, ...TRANSITION_RULES],
};
