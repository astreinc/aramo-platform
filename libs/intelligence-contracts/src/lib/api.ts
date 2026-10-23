import type { SourceSystemId } from './events.js';

// ADR-0036 Decision 3/4/§6 — the TI HTTP surface. The ingestion DTOs live in
// ./ingest.ts (T2 closed admission schema), verification in ./verification.ts.
// This file: health, the read API (T6), trust vocabulary, entitlement sync.

export const INTELLIGENCE_SERVICE_NAME = 'talent-intelligence-service' as const;

export interface IntelligenceHealthResponse {
  service: typeof INTELLIGENCE_SERVICE_NAME;
  status: 'ok' | 'degraded';
  database: 'ok' | 'unavailable';
}

// ── trust vocabulary (bands, never numbers) ─────────────────────────────────

export const TRUST_DIMENSIONS = ['IDENTITY', 'CLAIMS', 'CONTINUITY', 'ELIGIBILITY'] as const;
export type TrustDimension = (typeof TRUST_DIMENSIONS)[number];

/** Ordered weakest → strongest. */
export const TRUST_BANDS = ['NOT_ESTABLISHED', 'SELF_ASSERTED', 'CORROBORATED', 'INDEPENDENTLY_VERIFIED', 'AUTHORITATIVE'] as const;
export type TrustBand = (typeof TRUST_BANDS)[number];

export interface TrustStateView {
  identity_band: TrustBand;
  claims_band: TrustBand;
  continuity_band: TrustBand;
  eligibility_band: TrustBand;
  open_contradiction_count: number;
  stale_assertion_count: number;
  has_open_dispute: boolean;
  /** Every first-hand assertion comes from one independent source. */
  single_source_only: boolean;
  /** A current platform verification is older than the staleness window. */
  verification_stale: boolean;
}

// ── read API (T6) ───────────────────────────────────────────────────────────

/**
 * TENANT_SCOPED (TI_CROSS_TENANT_READ_ENABLED=false, the default pending Legal
 * L-1): only the requesting tenant's own assertions plus TI-acquired evidence
 * and verification outcomes. CROSS_TENANT: the full Golden projection.
 */
export const READ_ACCESS_MODES = ['TENANT_SCOPED', 'CROSS_TENANT'] as const;
export type ReadAccessMode = (typeof READ_ACCESS_MODES)[number];

/** Resolved fact types of the projection. */
export const PROFILE_FACT_TYPES = [
  'NAME',
  'CURRENT_EMPLOYER',
  'TITLE',
  'LOCATION',
  'WORK_HISTORY',
  'SKILL',
  'EDUCATION',
  'CERTIFICATION',
  'PROJECT',
  'PUBLIC_PROFILE_URL',
  'AVAILABILITY',
  'WORK_AUTHORIZATION',
  'EMAIL',
  'PHONE',
] as const;
export type ProfileFactType = (typeof PROFILE_FACT_TYPES)[number];

/** Change marker carried in changed_fact_types when only the trust state moved. */
export const TRUST_CHANGE_MARKER = 'TRUST' as const;

export const FACT_STATES = ['RESOLVED', 'CONTRADICTED', 'STALE'] as const;
export type FactState = (typeof FACT_STATES)[number];

export interface ResolvedFactView {
  fact_type: ProfileFactType;
  /** '' for single-valued facts; a stable key for multi-valued ones. */
  fact_key: string;
  value: Record<string, unknown>;
  state: FactState;
  verification_status: 'DECLARED' | 'DOCUMENT_SUPPORTED' | 'VERIFIED';
  /** Distinct independent sources supporting the resolved value. */
  corroborating_sources: number;
  supporting_assertion_ids: string[];
}

export interface IntelligenceProfileReadResponse {
  intelligence_subject_id: string;
  access_mode: ReadAccessMode;
  facts: ResolvedFactView[];
  trust: TrustStateView;
  generated_at: string;
}

/** Who contributed an assertion, from the reader's point of view — another tenant's id is never revealed. */
export const CONTRIBUTORS = ['REQUESTING_TENANT', 'OTHER_SOURCE', 'TALENT_INTELLIGENCE'] as const;
export type Contributor = (typeof CONTRIBUTORS)[number];

export interface EvidenceEventView {
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  at: string;
}

export interface EvidenceAssertionView {
  assertion_id: string;
  assertion_type: string;
  admission_class: 'A' | 'B';
  payload: Record<string, unknown>;
  contributed_by: Contributor;
  source_kind: string;
  verification_status: string;
  /** Status as seen in this access mode (a contradiction by a hidden source is not shown). */
  status: string;
  observed_at: string;
  valid_from: string | null;
  valid_to: string | null;
  ai_derived: boolean;
  source_document_hash: string | null;
  history: EvidenceEventView[];
}

export interface IntelligenceEvidenceReadResponse {
  intelligence_subject_id: string;
  access_mode: ReadAccessMode;
  assertions: EvidenceAssertionView[];
  generated_at: string;
}

export interface IntelligenceArtifactView {
  artifact_id: string;
  document_type: string;
  issuer: string | null;
  sha256: string;
  retrieved_at: string;
  supports_assertion_ids: string[];
}

export interface IntelligenceArtifactsReadResponse {
  intelligence_subject_id: string;
  access_mode: ReadAccessMode;
  artifacts: IntelligenceArtifactView[];
  generated_at: string;
}

/** Read refusals: 403 NOT_ENTITLED / SOURCE_SYSTEM_MISMATCH, 404 REFERENCE_NOT_FOUND. */
export const READ_REFUSAL_CODES = ['NOT_ENTITLED', 'SOURCE_SYSTEM_MISMATCH', 'REFERENCE_NOT_FOUND'] as const;
export type ReadRefusalCode = (typeof READ_REFUSAL_CODES)[number];

// ── entitlement sync (T6) ───────────────────────────────────────────────────

/**
 * POST /v1/entitlements/sync — the ATS tells TI which of its tenants hold the
 * `intelligence` capability. UPSERT applies the listed rows; REPLACE also
 * deactivates every tenant of the source system that is not listed.
 */
export interface EntitlementSyncRequest {
  source_system_id: SourceSystemId;
  mode: 'UPSERT' | 'REPLACE';
  tenants: Array<{ tenant_id: string; active: boolean }>;
}

export interface EntitlementSyncResponse {
  applied: number;
  deactivated: number;
}

export const ENTITLEMENT_SYNC_MAX_TENANTS = 10_000;
