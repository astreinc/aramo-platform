import type { Contributor } from './api.js';
import { SOURCE_SYSTEM_IDS, type SourceSystemId } from './events.js';
import type { VerificationIdentifierType } from './verification.js';

// ATI-SEP-1 T10 (Addendum A3 T10-2 / T10-3) — the Talent Intelligence evidence
// lifecycle surface: talent-raised disputes, the trust-proposal worklist,
// contradiction resolution and the verification-status reads. ATS and portal
// surfaces call these through the ATS HTTP client. TI outcomes are enrichment
// only and never gate an ATS decision.
//
//   M-1 GET  /v1/references/:sys/:tenant/:talent/verifications              (intelligence:verify)
//   M-2 GET  /v1/tenants/:tenant/proposals · POST /v1/proposals/:id/{dismiss,act} (intelligence:proposals)
//   M-3 POST /v1/references/:sys/:tenant/:talent/assertions/:id/contradiction-resolution (intelligence:proposals)
//   M-4 POST /v1/disputes · GET /v1/disputes · GET /v1/disputes/:id · POST /v1/disputes/:id/{respond,withdraw}
//       GET /v1/tenants/:tenant/disputes[/:id] · POST /v1/disputes/:id/{triage,request-info,correct,uphold,extend}
//                                                                          (intelligence:disputes)
//   M-6 GET  /v1/verifications?reference=…                                 (intelligence:verify)
//
// Every request body is CLOSED (unknown keys → 400). Free text (statements,
// notes, justifications, reasons) is 1–4000 characters.

/** One source-system talent reference, e.g. the ATS record the portal session belongs to. */
export interface TalentReferenceTuple {
  source_system_id: SourceSystemId;
  source_tenant_id: string;
  external_talent_id: string;
}

// ── refusals ────────────────────────────────────────────────────────────────

/**
 * 400 INVALID_REQUEST · 403 NOT_ENTITLED / SOURCE_SYSTEM_MISMATCH / RESOLUTION_NOT_PERMITTED ·
 * 404 REFERENCE_NOT_FOUND / NOT_FOUND · 409 PROPOSAL_NOT_OPEN ·
 * 422 ASSERTION_NOT_DISPUTABLE / DISPUTE_NOT_OPEN / DISPUTE_NOT_UNDER_REVIEW /
 *     DISPUTE_EXTENSION_USED / ASSERTION_NOT_CONTRADICTED.
 * Something the caller may not see is indistinguishable from something that does not exist (404).
 */
export const LIFECYCLE_REFUSAL_CODES = [
  'INVALID_REQUEST',
  'NOT_ENTITLED',
  'SOURCE_SYSTEM_MISMATCH',
  'RESOLUTION_NOT_PERMITTED',
  'REFERENCE_NOT_FOUND',
  'NOT_FOUND',
  'PROPOSAL_NOT_OPEN',
  'ASSERTION_NOT_DISPUTABLE',
  'DISPUTE_NOT_OPEN',
  'DISPUTE_NOT_UNDER_REVIEW',
  'DISPUTE_EXTENSION_USED',
  'ASSERTION_NOT_CONTRADICTED',
] as const;
export type LifecycleRefusalCode = (typeof LIFECYCLE_REFUSAL_CODES)[number];

export const LIFECYCLE_REFUSAL_HTTP_STATUS: Record<LifecycleRefusalCode, number> = {
  INVALID_REQUEST: 400,
  NOT_ENTITLED: 403,
  SOURCE_SYSTEM_MISMATCH: 403,
  RESOLUTION_NOT_PERMITTED: 403,
  REFERENCE_NOT_FOUND: 404,
  NOT_FOUND: 404,
  PROPOSAL_NOT_OPEN: 409,
  ASSERTION_NOT_DISPUTABLE: 422,
  DISPUTE_NOT_OPEN: 422,
  DISPUTE_NOT_UNDER_REVIEW: 422,
  DISPUTE_EXTENSION_USED: 422,
  ASSERTION_NOT_CONTRADICTED: 422,
};

// ── disputes (M-4) ──────────────────────────────────────────────────────────

/**
 * The dispute state machine (ported from the legacy portal dispute):
 *   OPEN ──triage──▶ UNDER_REVIEW ──correct──▶ RESOLVED_CORRECTED   (assertion DISPUTED → REVOKED)
 *                                 ──uphold───▶ RESOLVED_UPHELD      (assertion DISPUTED → VALID)
 *   OPEN | UNDER_REVIEW ──withdraw (talent)──▶ WITHDRAWN            (DISPUTED → VALID when triaged)
 *   triage / correct / uphold on an assertion that can no longer move ──▶ RESOLVED_NO_TRANSITION
 * Terminal: RESOLVED_CORRECTED | RESOLVED_UPHELD | WITHDRAWN | RESOLVED_NO_TRANSITION.
 */
export const DISPUTE_STATUSES = [
  'OPEN',
  'UNDER_REVIEW',
  'RESOLVED_CORRECTED',
  'RESOLVED_UPHELD',
  'WITHDRAWN',
  'RESOLVED_NO_TRANSITION',
] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

/** Non-terminal states: one dispute per assertion may be in one of these at a time. */
export const DISPUTE_OPEN_STATUSES = ['OPEN', 'UNDER_REVIEW'] as const satisfies readonly DisputeStatus[];

export const DISPUTE_STATEMENT_AUTHORS = ['TALENT', 'TENANT'] as const;
export type DisputeStatementAuthor = (typeof DISPUTE_STATEMENT_AUTHORS)[number];

/**
 * SLA clocks, recorded as due timestamps at open (days from opened_at). Report-only:
 * nothing escalates or resolves automatically. The reinvestigation clock may be
 * extended ONCE by reinvestigationExtensionDays (POST /v1/disputes/:id/extend).
 */
export const DISPUTE_SLA = {
  triageDueDays: 3,
  summaryDueDays: 5,
  reinvestigationDueDays: 30,
  reinvestigationExtensionDays: 15,
  ccpaInitialDays: 45,
  ccpaExtensionDays: 45,
} as const;

export const LIFECYCLE_TEXT_MAX = 4000;
export const DISPUTE_LIST_MAX_REFERENCES = 50;
export const LIFECYCLE_PAGE_DEFAULT_LIMIT = 25;
export const LIFECYCLE_PAGE_MAX_LIMIT = 100;

/** POST /v1/disputes — the talent disputes one assertion through a reference they hold. */
export interface OpenDisputeRequest {
  portal_context: TalentReferenceTuple;
  assertion_id: string;
  statement: string;
}

/** POST /v1/disputes/:id/respond — a further talent statement while the dispute is open. */
export interface RespondDisputeRequest {
  portal_context: TalentReferenceTuple;
  statement: string;
}

/** POST /v1/disputes/:id/withdraw — terminal talent action (idempotent once terminal). */
export interface WithdrawDisputeRequest {
  portal_context: TalentReferenceTuple;
  /** The portal principal (opaque id) recorded as the actor. */
  actor?: string;
}

/** Tenant disposition: triage / extend carry no note; request-info / correct / uphold require one. */
export interface TenantDisputeActionRequest {
  source_tenant_id: string;
  /** The ATS user acting (opaque id). */
  actor: string;
  note?: string;
}

export interface DisputeStatementView {
  author: DisputeStatementAuthor;
  statement: string;
  created_at: string;
}

export interface DisputeSlaView {
  triage_due_at: string;
  summary_due_at: string;
  reinvestigation_due_at: string;
  reinvestigation_extended_at: string | null;
  ccpa_due_at: string | null;
  ccpa_extended_due_at: string | null;
}

export interface PortalDisputeSummary {
  dispute_id: string;
  assertion_id: string;
  assertion_type: string;
  status: DisputeStatus;
  opened_at: string;
  updated_at: string;
  resolution_note: string | null;
  sla: DisputeSlaView;
}

export interface PortalDisputeView extends PortalDisputeSummary {
  statements: DisputeStatementView[];
}

export interface PortalDisputeListResponse {
  items: PortalDisputeSummary[];
}

export interface TenantDisputeSummary {
  dispute_id: string;
  /** The requesting tenant's own ACTIVE talent references on the disputed subject. */
  external_talent_ids: string[];
  assertion_id: string;
  assertion_type: string;
  contributed_by: Contributor;
  status: DisputeStatus;
  opened_at: string;
  updated_at: string;
  triage_due_at: string;
  reinvestigation_due_at: string;
}

export interface TenantDisputeView extends TenantDisputeSummary {
  assertion_status: string;
  assertion_payload: Record<string, unknown>;
  resolution_note: string | null;
  no_transition_reason: string | null;
  sla: DisputeSlaView;
  statements: DisputeStatementView[];
}

export interface TenantDisputeListResponse {
  items: TenantDisputeSummary[];
  next_cursor: string | null;
}

export interface DisputeActionResponse {
  dispute_id: string;
  status: DisputeStatus;
}

// ── proposals (M-2) ─────────────────────────────────────────────────────────

/** VERIFY_CONTACT ← single source ∧ a never-verified contact; RENEW_VERIFICATION ← a stale TI verification; RESOLVE_CONTRADICTION ← each open contradiction. */
export const PROPOSAL_KINDS = ['VERIFY_CONTACT', 'RENEW_VERIFICATION', 'RESOLVE_CONTRADICTION'] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export const PROPOSAL_TRIGGER_KINDS = ['SINGLE_SOURCE_ONLY', 'VERIFICATION_STALE', 'OPEN_CONTRADICTION'] as const;
export type ProposalTriggerKind = (typeof PROPOSAL_TRIGGER_KINDS)[number];

/** OPEN → DISMISSED | ACTED | SETTLED (all terminal). SETTLED = the trigger cleared on regeneration. A DISMISSED basis never re-opens. */
export const PROPOSAL_STATUSES = ['OPEN', 'DISMISSED', 'ACTED', 'SETTLED'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** What the human did through the real (separately gated) action — the proposal records it and executes nothing. */
export const PROPOSAL_ACTIONS = ['VERIFICATION_REQUESTED', 'CONTRADICTION_RESOLVED', 'RECORD_UPDATED'] as const;
export type ProposalAction = (typeof PROPOSAL_ACTIONS)[number];

export interface ProposalView {
  proposal_id: string;
  /** The requesting tenant's own ACTIVE talent references on the proposal's subject. */
  external_talent_ids: string[];
  kind: ProposalKind;
  trigger_kind: ProposalTriggerKind;
  status: ProposalStatus;
  /** RESOLVE_CONTRADICTION: the contradicted assertion. */
  assertion_id: string | null;
  assertion_type: string | null;
  /** VERIFY_CONTACT / RENEW_VERIFICATION: the contact, by type + digest only (sha256 of `TYPE:normalized_value`). */
  identifier_type: VerificationIdentifierType | null;
  identifier_digest: string | null;
  justification: string | null;
  action: ProposalAction | null;
  created_at: string;
  acted_at: string | null;
}

export interface ProposalListResponse {
  items: ProposalView[];
  next_cursor: string | null;
}

export interface DismissProposalRequest {
  source_tenant_id: string;
  actor: string;
  justification: string;
}

export interface ActProposalRequest {
  source_tenant_id: string;
  actor: string;
  action: ProposalAction;
  note?: string;
}

// ── contradiction resolution (M-3) ──────────────────────────────────────────

/**
 * KEEP    — the assertion stands: its contradictions in the tenant's view are reconciled
 *           (AssertionLink RECONCILES) and it returns to VALID.
 * RETRACT — the assertion is wrong: REVOKED. Only for an assertion the requesting tenant contributed.
 * Recorded as the tenant's enrichment decision (AssertionEvent CONTRADICTION_RESOLVED); never mutates ATS data.
 */
export const CONTRADICTION_RESOLUTIONS = ['KEEP', 'RETRACT'] as const;
export type ContradictionResolution = (typeof CONTRADICTION_RESOLUTIONS)[number];

export interface ContradictionResolutionRequest {
  resolution: ContradictionResolution;
  reason: string;
  actor: string;
}

export interface ContradictionResolutionResponse {
  assertion_id: string;
  resolution: ContradictionResolution;
  /** The assertion's stored status after the resolution. */
  status: string;
  reconciled_with: string[];
}

// ── verification status (M-1, M-6) ──────────────────────────────────────────

export const IDENTIFIER_VERIFICATION_STATES = ['VERIFIED', 'PENDING', 'UNVERIFIED'] as const;
export type IdentifierVerificationState = (typeof IDENTIFIER_VERIFICATION_STATES)[number];

/** Re-verification falls due this many days after verified_at (the trust staleness window). */
export const VERIFICATION_VALIDITY_DAYS = 365;

export interface ReferenceVerificationItem {
  identifier_type: VerificationIdentifierType;
  value_masked: string;
  status: IdentifierVerificationState;
  /** PENDING: the code's expiry. VERIFIED: when re-verification falls due. UNVERIFIED: null. */
  expires_at: string | null;
}

export interface ReferenceVerificationsResponse {
  items: ReferenceVerificationItem[];
}

export interface PortalVerificationItem {
  identifier_type: VerificationIdentifierType;
  value_masked: string;
  status: IdentifierVerificationState;
  verified_at: string | null;
  first_seen_at: string;
  /** The TI verification-outcome assertion (disputable through POST /v1/disputes), when one exists. */
  assertion_id: string | null;
}

export interface PortalVerificationsResponse {
  items: PortalVerificationItem[];
}

// ── validators ──────────────────────────────────────────────────────────────

export type LifecycleValidationResult<T> = { ok: true; value: T } | { ok: false; issues: string[] };

const ID_PATTERN = /^[A-Za-z0-9._:@-]{1,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === 'string' && ID_PATTERN.test(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= LIFECYCLE_TEXT_MAX;

export const isLifecycleId = isId;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_PATTERN.test(v);

function closed(obj: Record<string, unknown>, allowed: readonly string[], path: string, issues: string[]): void {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) issues.push(`${path}.${k}: unknown key`);
}

function tuple(v: unknown, path: string, issues: string[]): void {
  if (!isObj(v)) {
    issues.push(`${path}: must be an object`);
    return;
  }
  closed(v, ['source_system_id', 'source_tenant_id', 'external_talent_id'], path, issues);
  if (!(SOURCE_SYSTEM_IDS as readonly unknown[]).includes(v['source_system_id'])) issues.push(`${path}.source_system_id: unknown`);
  if (!isId(v['source_tenant_id'])) issues.push(`${path}.source_tenant_id: invalid`);
  if (!isId(v['external_talent_id'])) issues.push(`${path}.external_talent_id: invalid`);
}

function text(v: unknown, path: string, issues: string[]): void {
  if (!isText(v)) issues.push(`${path}: 1-${LIFECYCLE_TEXT_MAX} characters`);
}

function result<T>(input: unknown, issues: string[]): LifecycleValidationResult<T> {
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: input as T };
}

export function validateOpenDisputeRequest(input: unknown): LifecycleValidationResult<OpenDisputeRequest> {
  if (!isObj(input)) return { ok: false, issues: ['$: must be an object'] };
  const issues: string[] = [];
  closed(input, ['portal_context', 'assertion_id', 'statement'], '$', issues);
  tuple(input['portal_context'], '$.portal_context', issues);
  if (!isUuid(input['assertion_id'])) issues.push('$.assertion_id: a uuid');
  text(input['statement'], '$.statement', issues);
  return result(input, issues);
}

export function validateRespondDisputeRequest(input: unknown): LifecycleValidationResult<RespondDisputeRequest> {
  if (!isObj(input)) return { ok: false, issues: ['$: must be an object'] };
  const issues: string[] = [];
  closed(input, ['portal_context', 'statement'], '$', issues);
  tuple(input['portal_context'], '$.portal_context', issues);
  text(input['statement'], '$.statement', issues);
  return result(input, issues);
}

export function validateWithdrawDisputeRequest(input: unknown): LifecycleValidationResult<WithdrawDisputeRequest> {
  if (!isObj(input)) return { ok: false, issues: ['$: must be an object'] };
  const issues: string[] = [];
  closed(input, ['portal_context', 'actor'], '$', issues);
  tuple(input['portal_context'], '$.portal_context', issues);
  if (input['actor'] !== undefined && !isId(input['actor'])) issues.push('$.actor: invalid');
  return result(input, issues);
}

/** `note`: 'required' (request-info / correct / uphold) or 'forbidden' (triage / extend). */
export function validateTenantDisputeActionRequest(
  input: unknown,
  note: 'required' | 'forbidden',
): LifecycleValidationResult<TenantDisputeActionRequest> {
  if (!isObj(input)) return { ok: false, issues: ['$: must be an object'] };
  const issues: string[] = [];
  closed(input, note === 'required' ? ['source_tenant_id', 'actor', 'note'] : ['source_tenant_id', 'actor'], '$', issues);
  if (!isId(input['source_tenant_id'])) issues.push('$.source_tenant_id: invalid');
  if (!isId(input['actor'])) issues.push('$.actor: invalid');
  if (note === 'required') text(input['note'], '$.note', issues);
  return result(input, issues);
}

export function validateDismissProposalRequest(input: unknown): LifecycleValidationResult<DismissProposalRequest> {
  if (!isObj(input)) return { ok: false, issues: ['$: must be an object'] };
  const issues: string[] = [];
  closed(input, ['source_tenant_id', 'actor', 'justification'], '$', issues);
  if (!isId(input['source_tenant_id'])) issues.push('$.source_tenant_id: invalid');
  if (!isId(input['actor'])) issues.push('$.actor: invalid');
  text(input['justification'], '$.justification', issues);
  return result(input, issues);
}

export function validateActProposalRequest(input: unknown): LifecycleValidationResult<ActProposalRequest> {
  if (!isObj(input)) return { ok: false, issues: ['$: must be an object'] };
  const issues: string[] = [];
  closed(input, ['source_tenant_id', 'actor', 'action', 'note'], '$', issues);
  if (!isId(input['source_tenant_id'])) issues.push('$.source_tenant_id: invalid');
  if (!isId(input['actor'])) issues.push('$.actor: invalid');
  if (!(PROPOSAL_ACTIONS as readonly unknown[]).includes(input['action'])) issues.push(`$.action: ${PROPOSAL_ACTIONS.join(' | ')}`);
  if (input['note'] !== undefined) text(input['note'], '$.note', issues);
  return result(input, issues);
}

export function validateContradictionResolutionRequest(input: unknown): LifecycleValidationResult<ContradictionResolutionRequest> {
  if (!isObj(input)) return { ok: false, issues: ['$: must be an object'] };
  const issues: string[] = [];
  closed(input, ['resolution', 'reason', 'actor'], '$', issues);
  if (!(CONTRADICTION_RESOLUTIONS as readonly unknown[]).includes(input['resolution'])) issues.push(`$.resolution: ${CONTRADICTION_RESOLUTIONS.join(' | ')}`);
  text(input['reason'], '$.reason', issues);
  if (!isId(input['actor'])) issues.push('$.actor: invalid');
  return result(input, issues);
}

// ── the `reference` query parameter (M-6, portal dispute reads) ─────────────

/** `reference=SOURCE_SYSTEM/TENANT/TALENT` — '/' never occurs inside an id. */
export function formatReferenceParam(t: TalentReferenceTuple): string {
  return `${t.source_system_id}/${t.source_tenant_id}/${t.external_talent_id}`;
}

/** Parse one or more `reference` query values (repeatable, at most DISPUTE_LIST_MAX_REFERENCES, de-duplicated). */
export function parseReferenceParams(raw: unknown): LifecycleValidationResult<TalentReferenceTuple[]> {
  const values = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  if (values.length === 0) return { ok: false, issues: ['reference: at least one SOURCE_SYSTEM/TENANT/TALENT is required'] };
  if (values.length > DISPUTE_LIST_MAX_REFERENCES) return { ok: false, issues: [`reference: at most ${DISPUTE_LIST_MAX_REFERENCES}`] };
  const issues: string[] = [];
  const out = new Map<string, TalentReferenceTuple>();
  values.forEach((v, i) => {
    const parts = typeof v === 'string' ? v.split('/') : [];
    const [sys, tenant, talent] = parts;
    if (parts.length !== 3 || !(SOURCE_SYSTEM_IDS as readonly unknown[]).includes(sys) || !isId(tenant) || !isId(talent)) {
      issues.push(`reference[${i}]: SOURCE_SYSTEM/TENANT/TALENT`);
      return;
    }
    const t = { source_system_id: sys as SourceSystemId, source_tenant_id: tenant, external_talent_id: talent };
    out.set(formatReferenceParam(t), t);
  });
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: [...out.values()] };
}
