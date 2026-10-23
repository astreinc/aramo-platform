import { ROLE_FAMILIES, type RoleFamily } from './dto/matching-analysis-input.dto.js';

// ATI-SEP-1 Addendum A2 ruling A-c (P1) — the platform-owned MatchingPolicy.
//
// The calibration knobs of the §2.5 engine are platform reference data: the SaaS
// Platform Owner governs them through the Platform Admin Portal (versioned,
// append-only, exactly one ACTIVE version, stored in the skills_taxonomy schema);
// tenants consume them and can never edit them. Matching EXECUTION stays ATS-side:
// the engine below remains a pure function — the active policy is handed to it as a
// parameter by the caller (MatchingService resolves it through the injected
// MATCHING_POLICY_SOURCE port; apps/api binds that port to the store).
//
// Calibration knobs carried by a policy version:
//   - evidence_thresholds[role_family].count             (§2.5 Threshold Calibration)
//   - evidence_thresholds[role_family].requires_ingested (§2.5 Threshold Calibration)
// Every other engine constant (the hard/soft classification of each criterion, the
// confidence floor 'medium', the blocking risk severity 'high', the constraint value
// semantics) is the §2.5 Rule Set itself, not calibration, and is NOT policy-editable.

export interface RoleFamilyEvidenceThreshold {
  readonly count: number;
  readonly requires_ingested: boolean;
}

export type EvidenceThresholds = Readonly<Record<RoleFamily, RoleFamilyEvidenceThreshold>>;

export interface MatchingPolicy {
  // The store version number the engine ran with; null = the compiled defaults (the
  // store is empty or no source is bound).
  readonly version_number: number | null;
  readonly evidence_thresholds: EvidenceThresholds;
}

// The compiled defaults — §2.5 Threshold Calibration exactly. Architect = 3; every
// other family = 2. PM/BA do not require ingested evidence. The store's seeded
// version 1 carries these values byte-for-byte (proved by
// apps/api/src/tests/matching-policy-seed.spec.ts).
export const DEFAULT_EVIDENCE_THRESHOLDS: EvidenceThresholds = Object.freeze({
  backend_engineer:        Object.freeze({ count: 2, requires_ingested: true }),
  frontend_engineer:       Object.freeze({ count: 2, requires_ingested: true }),
  fullstack_engineer:      Object.freeze({ count: 2, requires_ingested: true }),
  devops_sre:              Object.freeze({ count: 2, requires_ingested: true }),
  data_engineer:           Object.freeze({ count: 2, requires_ingested: true }),
  architect:               Object.freeze({ count: 3, requires_ingested: true }),
  qa_test_engineer:        Object.freeze({ count: 2, requires_ingested: true }),
  product_project_manager: Object.freeze({ count: 2, requires_ingested: false }),
  business_analyst:        Object.freeze({ count: 2, requires_ingested: false }),
});

export const DEFAULT_MATCHING_POLICY: MatchingPolicy = Object.freeze({
  version_number: null,
  evidence_thresholds: DEFAULT_EVIDENCE_THRESHOLDS,
});

// Inclusive bounds on a stored evidence count. A count below 1 would let a critical
// skill with a single piece of evidence clear the bar trivially (0 is already a HARD
// missing-skill failure); the ceiling only guards against typos.
export const EVIDENCE_COUNT_MIN = 1;
export const EVIDENCE_COUNT_MAX = 20;

export type EvidenceThresholdsParseResult =
  | { readonly ok: true; readonly thresholds: EvidenceThresholds }
  | { readonly ok: false; readonly errors: readonly string[] };

// Strict shape check for a thresholds document (an API request body or a stored
// JSON column). EVERY role family must be present, no unknown family is allowed, and
// each entry is exactly { count: integer in bounds, requires_ingested: boolean }.
// Pure; never throws.
export function parseEvidenceThresholds(raw: unknown): EvidenceThresholdsParseResult {
  const errors: string[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['evidence_thresholds must be an object keyed by role family'] };
  }
  const record = raw as Record<string, unknown>;
  const known = new Set<string>(ROLE_FAMILIES);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) errors.push(`unknown role family: ${key}`);
  }
  const out: Partial<Record<RoleFamily, RoleFamilyEvidenceThreshold>> = {};
  for (const family of ROLE_FAMILIES) {
    const entry = record[family];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${family}: missing threshold`);
      continue;
    }
    const e = entry as Record<string, unknown>;
    const extra = Object.keys(e).filter((k) => k !== 'count' && k !== 'requires_ingested');
    if (extra.length > 0) errors.push(`${family}: unknown field(s) ${extra.join(', ')}`);
    const count = e['count'];
    const requiresIngested = e['requires_ingested'];
    if (
      typeof count !== 'number' ||
      !Number.isInteger(count) ||
      count < EVIDENCE_COUNT_MIN ||
      count > EVIDENCE_COUNT_MAX
    ) {
      errors.push(
        `${family}.count must be an integer between ${String(EVIDENCE_COUNT_MIN)} and ${String(EVIDENCE_COUNT_MAX)}`,
      );
    }
    if (typeof requiresIngested !== 'boolean') {
      errors.push(`${family}.requires_ingested must be a boolean`);
    }
    if (typeof count === 'number' && typeof requiresIngested === 'boolean') {
      out[family] = Object.freeze({ count, requires_ingested: requiresIngested });
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, thresholds: Object.freeze(out as Record<RoleFamily, RoleFamilyEvidenceThreshold>) };
}

// The port MatchingService reads the ACTIVE policy through. Bound at the composition
// root (apps/api); libs/matching never imports the store. getActivePolicy returns
// null when the store holds no ACTIVE version (→ compiled defaults). A store read
// error or a malformed stored document propagates — matching never silently falls
// back to defaults when the platform owner's policy cannot be read.
export const MATCHING_POLICY_SOURCE = 'MATCHING_POLICY_SOURCE';

export interface MatchingPolicySource {
  getActivePolicy(): Promise<MatchingPolicy | null>;
}
