// Closed, source-controlled registries + type-guards for the canonical E2 domain
// (Track 3 / E2, first-write). const-plus-type-guard precedent: VALID_OVERRIDE_TYPES
// (libs/examination) / RESTRICTION_TYPE_VALUES (E7). Every list is closed at
// compile time and at runtime; an out-of-list value is refused at the controller
// boundary as a domain error, never a generic 400. No arbitrary text introduces
// executable requirement semantics (§4c); `label` is a custom display string only.

import { createHash } from 'node:crypto';

// RequirementType — the closed registry, RATIFIED (PO 2026-08-04) as the exact
// seven-value first-write set (supersedes the §4c proposed list: SITE_BADGE →
// BADGE_PROVISIONING, CLIENT_ORIENTATION removed, CREDENTIAL_VERIFICATION added).
// Extension is a code change under review, never a data op.
export const REQUIREMENT_TYPE_VALUES = [
  'BACKGROUND_CHECK',
  'DRUG_SCREEN',
  'I9_VERIFICATION',
  'CREDENTIAL_VERIFICATION',
  'BADGE_PROVISIONING',
  'CLIENT_PAPERWORK',
  'NDA',
] as const;
export type RequirementTypeValue = (typeof REQUIREMENT_TYPE_VALUES)[number];
export function isRequirementType(v: unknown): v is RequirementTypeValue {
  return typeof v === 'string' && (REQUIREMENT_TYPE_VALUES as readonly string[]).includes(v);
}

// ScopeType — definition-set applicability discriminator (§4b). TENANT ONLY today
// (scope_ref_id == tenant_id). Client/requisition scopes and their precedence are
// L5-P5 (ruling P2) — the layered onboarding-config scopes, least-specific to
// most-specific. resolveEffective merges the open published set at each present
// layer keyed on requirement_type: a more-specific layer OVERRIDES the same type and
// AUGMENTS with new types. The order in this tuple IS the precedence order (index =
// specificity). Adding a scope is a source-controlled registry change (never a data op).
export const SCOPE_TYPE_VALUES = ['TENANT', 'CLIENT', 'REQUISITION'] as const;
export type ScopeTypeValue = (typeof SCOPE_TYPE_VALUES)[number];
export function isScopeType(v: unknown): v is ScopeTypeValue {
  return typeof v === 'string' && (SCOPE_TYPE_VALUES as readonly string[]).includes(v);
}

// RequirementStatus — the compact governed operational state (§14 A2). REOPENED
// is NOT a persisted status; it is a privileged audited action returning a
// resolved instance to PENDING.
export const REQUIREMENT_STATUS_VALUES = [
  'PENDING',
  'IN_PROGRESS',
  'SATISFIED',
  'FAILED',
  'WAIVED',
  'CANCELED',
] as const;
export type RequirementStatusValue = (typeof REQUIREMENT_STATUS_VALUES)[number];
export function isRequirementStatus(v: unknown): v is RequirementStatusValue {
  return typeof v === 'string' && (REQUIREMENT_STATUS_VALUES as readonly string[]).includes(v);
}

// RESOLVED = SATISFIED | WAIVED | CANCELED (does not hold the placement).
// UNRESOLVED = PENDING | IN_PROGRESS | FAILED (a blocking one holds it).
const RESOLVED: ReadonlySet<RequirementStatusValue> = new Set(['SATISFIED', 'WAIVED', 'CANCELED']);
export function isResolvedStatus(s: RequirementStatusValue): boolean {
  return RESOLVED.has(s);
}
export function isUnresolvedStatus(s: RequirementStatusValue): boolean {
  return !RESOLVED.has(s);
}

// WaiverMode — per-definition (§14 A2 / WAIVER MODEL).
export const WAIVER_MODE_VALUES = [
  'NOT_WAIVABLE',
  'CLIENT_AUTHORITY_ONLY',
  'COMPLIANCE_AUTHORITY_ONLY',
  'AUTHORIZED_INTERNAL',
] as const;
export type WaiverModeValue = (typeof WAIVER_MODE_VALUES)[number];
export function isWaiverMode(v: unknown): v is WaiverModeValue {
  return typeof v === 'string' && (WAIVER_MODE_VALUES as readonly string[]).includes(v);
}

// WaiverAuthority — the authority CLASS a waiver is asserted under. Validated
// against the instance's SNAPSHOTTED waiver_mode (never the live definition).
export const WAIVER_AUTHORITY_VALUES = ['CLIENT', 'COMPLIANCE', 'INTERNAL'] as const;
export type WaiverAuthorityValue = (typeof WAIVER_AUTHORITY_VALUES)[number];
export function isWaiverAuthority(v: unknown): v is WaiverAuthorityValue {
  return typeof v === 'string' && (WAIVER_AUTHORITY_VALUES as readonly string[]).includes(v);
}

// The authority class REQUIRED to waive under a given waiver_mode. NOT_WAIVABLE
// maps to null — no authority, no scope, no fallback can ever waive it. This is
// the fail-closed floor evaluated against the snapshot.
const WAIVER_MODE_TO_AUTHORITY: Readonly<Record<WaiverModeValue, WaiverAuthorityValue | null>> = {
  NOT_WAIVABLE: null,
  CLIENT_AUTHORITY_ONLY: 'CLIENT',
  COMPLIANCE_AUTHORITY_ONLY: 'COMPLIANCE',
  AUTHORIZED_INTERNAL: 'INTERNAL',
};
export function requiredAuthorityFor(mode: WaiverModeValue): WaiverAuthorityValue | null {
  return WAIVER_MODE_TO_AUTHORITY[mode];
}
// A waiver is permissible ONLY if the mode is waivable AND the asserted authority
// is exactly the class the snapshotted mode requires. NOT_WAIVABLE => never.
export function isWaiverPermitted(mode: WaiverModeValue, authority: string): boolean {
  const required = WAIVER_MODE_TO_AUTHORITY[mode];
  return required !== null && authority === required;
}

// AuditAction — consequential requirement actions recorded in the immutable
// provenance ledger (§14 A2).
export const AUDIT_ACTION_VALUES = [
  'SATISFIED',
  'FAILED',
  'WAIVED',
  'CANCELED',
  'REOPENED',
] as const;
export type AuditActionValue = (typeof AUDIT_ACTION_VALUES)[number];
export function isAuditAction(v: unknown): v is AuditActionValue {
  return typeof v === 'string' && (AUDIT_ACTION_VALUES as readonly string[]).includes(v);
}

// DefinitionSet publication state (§4.1).
export const SET_STATE_VALUES = ['draft', 'published', 'superseded'] as const;
export type SetStateValue = (typeof SET_STATE_VALUES)[number];
export function isSetState(v: unknown): v is SetStateValue {
  return typeof v === 'string' && (SET_STATE_VALUES as readonly string[]).includes(v);
}

// Legal status moves (app-side guard — NOT a generated DB matrix, §5 finding).
// The key is the current status; the value is the set it may move to. REOPENED
// is expressed as a resolved status returning to PENDING (a privileged action).
const STATUS_MOVES: Readonly<Record<RequirementStatusValue, ReadonlySet<RequirementStatusValue>>> = {
  PENDING: new Set(['IN_PROGRESS', 'SATISFIED', 'FAILED', 'WAIVED', 'CANCELED']),
  IN_PROGRESS: new Set(['SATISFIED', 'FAILED', 'WAIVED', 'CANCELED']),
  SATISFIED: new Set(['PENDING']),
  FAILED: new Set(['PENDING', 'SATISFIED', 'WAIVED', 'CANCELED']),
  WAIVED: new Set(['PENDING']),
  CANCELED: new Set(['PENDING']),
};
export function canMoveStatus(from: RequirementStatusValue, to: RequirementStatusValue): boolean {
  return STATUS_MOVES[from].has(to);
}
// A move INTO PENDING from a resolved/failed status is a REOPENED (privileged).
export function isReopen(from: RequirementStatusValue, to: RequirementStatusValue): boolean {
  return to === 'PENDING' && from !== 'PENDING' && from !== 'IN_PROGRESS';
}

// A definition entry as authored/published (the row shape).
export interface RequirementDefinitionInput {
  requirement_type: RequirementTypeValue;
  label: string;
  blocking: boolean;
  owner_role: string | null;
  sequence: number;
  waiver_mode: WaiverModeValue;
}

export function isRequirementDefinitionInput(v: unknown): v is RequirementDefinitionInput {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    isRequirementType(e['requirement_type']) &&
    typeof e['label'] === 'string' &&
    typeof e['blocking'] === 'boolean' &&
    (e['owner_role'] === null || typeof e['owner_role'] === 'string') &&
    typeof e['sequence'] === 'number' &&
    isWaiverMode(e['waiver_mode'])
  );
}

// Canonical serialization → SHA-256 checksum over the set's definitions (§4 Set
// checksum). Deterministic regardless of author order.
export function canonicalizeDefinitions(defs: readonly RequirementDefinitionInput[]): string {
  const canonical = [...defs]
    .sort((a, b) => a.sequence - b.sequence || a.requirement_type.localeCompare(b.requirement_type))
    .map((d) => ({
      requirement_type: d.requirement_type,
      label: d.label,
      blocking: d.blocking,
      owner_role: d.owner_role,
      sequence: d.sequence,
      waiver_mode: d.waiver_mode,
    }));
  return JSON.stringify(canonical);
}
export function checksumDefinitions(defs: readonly RequirementDefinitionInput[]): string {
  return createHash('sha256').update(canonicalizeDefinitions(defs)).digest('hex');
}
