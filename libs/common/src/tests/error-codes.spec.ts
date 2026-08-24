import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ERROR_CODES } from '../lib/errors/error-codes.js';

// PR-8.0a-Reground §10 schema/catalog test 49: ErrorCode enum in
// openapi/common.yaml MUST match ERROR_CODES tuple exactly (same values,
// same declaration order). Drift between TS tuple and YAML enum is the
// failure mode this gate prevents.
describe('ErrorCode catalog parity (TS tuple ↔ openapi/common.yaml)', () => {
  it('ERROR_CODES tuple matches ErrorCode enum in openapi/common.yaml', () => {
    const here = resolve(fileURLToPath(import.meta.url), '..');
    const yamlPath = resolve(here, '..', '..', '..', '..', 'openapi', 'common.yaml');
    const yaml = readFileSync(yamlPath, 'utf8');

    // Walk the file line-by-line: find the ErrorCode block, locate its
    // enum: header, then collect subsequent indented "- VALUE" lines until
    // a sibling key at the same indent ends the block. Avoids pulling a
    // YAML parser into the libs/common test surface.
    const lines = yaml.split('\n');
    const errorCodeIdx = lines.findIndex((l) => /^\s{4}ErrorCode:\s*$/.test(l));
    expect(errorCodeIdx).toBeGreaterThanOrEqual(0);
    const enumIdx = lines.findIndex(
      (l, i) => i > errorCodeIdx && /^\s{6}enum:\s*$/.test(l),
    );
    expect(enumIdx).toBeGreaterThan(errorCodeIdx);

    const yamlValues: string[] = [];
    for (let i = enumIdx + 1; i < lines.length; i++) {
      const m = /^\s{8}-\s+([A-Z_]+)\s*$/.exec(lines[i]!);
      if (m === null) break;
      yamlValues.push(m[1]!);
    }
    expect(yamlValues).toEqual([...ERROR_CODES]);
  });

  it('ERROR_CODES contains the closed code set (Track8-T8P1-vms-external-identity + 3 T2-P3B-selection-evidence normalization + 1 Track6-T6B2-commercial-revision-conflict); the toEqual array below is the authoritative membership+order assertion', () => {
    expect(ERROR_CODES).toEqual([
      'AUTH_REQUIRED',
      'INVALID_TOKEN',
      'TENANT_ACCESS_DENIED',
      'VALIDATION_ERROR',
      'IDEMPOTENCY_KEY_CONFLICT',
      'INTERNAL_ERROR',
      'INVALID_SCOPE_COMBINATION',
      'TENANT_SELECTION_REQUIRED',
      'REFRESH_TOKEN_INVALID',
      'INVALID_REQUEST',
      'INSUFFICIENT_PERMISSIONS',
      'NOT_FOUND',
      'SUBMITTAL_STRETCH_BLOCKED',
      'JUSTIFICATION_REQUIRED',
      'ATTESTATION_MISSING',
      'EXAMINATION_PINNED_OUTDATED',
      'SUBMITTAL_ALREADY_CONFIRMED',
      'OVERRIDE_INVALID',
      'REVOKE_NOT_ALLOWED',
      'SELECTION_EVENT_REF_NOT_FOUND',
      'SELECTION_REFERENCE_NOT_FOUND',
      'SELECTION_STATE_INVALID',
      'AI_PROVIDER_UNAVAILABLE',
      'AI_RATE_LIMITED',
      'SUBMITTAL_STATE_INVALID',
      'CONSENT_NOT_GRANTED_AT_SEND',
      'TENANT_CAPABILITY_NOT_ENTITLED',
      'INVALID_PIPELINE_TRANSITION',
      'REQUISITION_NO_OPENINGS',
      'TALENT_LINK_INVALID',
      'SAVED_LIST_ITEM_TYPE_MISMATCH',
      'IMPORT_THRESHOLD_EXCEEDED',
      'IMPORT_ALREADY_REVERTED',
      'IMPORT_REVERT_WINDOW_EXPIRED',
      'CANONICALIZATION_PAYLOAD_NOT_FOUND',
      'OBJECT_STORAGE_UPLOAD_FAILED',
      'PRESIGNED_URL_EXPIRED',
      // AUTHZ-2 — 3 platform-tier codes.
      'TENANT_ALREADY_EXISTS',
      'COGNITO_PROVISION_FAILED',
      'INVITATION_ALREADY_EXISTS',
      // AUTHZ-D4a — 1 management-edge cycle code.
      'MANAGEMENT_CYCLE_REJECTED',
      // TR-2a-B3a — 1 record-supersession operational-refusal code.
      'TALENT_RECORD_SUPERSEDED',
      // TR-6 B2 — 6 advisory-resolution domain refusal codes (replacing the
      // AramoExceptionFilter status-collapse on the advisory surface only).
      'ADVISORY_NOT_PENDING',
      'ADVISORY_NOT_MERGED',
      'ADVISORY_NO_MERGED_SUBJECT',
      'MERGE_SUBJECT_NOT_ACTIVE',
      'CONTRADICTION_OVERRIDE_REQUIRED',
      'REVERSAL_JUSTIFICATION_REQUIRED',
      // TR-3 B2 — 1 email-verification request consent gate (denied OR empty-ledger → 403).
      'VERIFICATION_CONSENT_REQUIRED',
      // TR-4 B1 — 1 canonical claim-shape write gate (registered type, non-canonical payload → 422).
      'CLAIM_SHAPE_INVALID',
      // TR-4 B3 — 1 resolve-contradiction refusal (non-CONTRADICTED record → 422).
      'EVIDENCE_NOT_CONTRADICTED',
      'TENANT_SUSPENDED',
      'TENANT_CLOSED',
      // TR-12 B1 — 1 dismiss-proposal refusal (non-OPEN proposal → 409).
      'PROPOSAL_NOT_OPEN',
      // TR-15 B1 — 3 dispute-machinery refusals (all 422).
      'EVIDENCE_NOT_DISPUTABLE',
      'EVIDENCE_NOT_DISPUTED',
      'DISPUTE_OUTCOME_INVALID',
      // Portal P3a — respond on a closed talent dispute (422).
      'PORTAL_DISPUTE_NOT_OPEN',
      // Portal P3b — reinvestigation extension already used (422).
      'PORTAL_DISPUTE_EXTENSION_USED',
      'POLICY_DENIED',
      // D3b — Charter §4 Amendment activity redaction (2).
      'ACTIVITY_NOT_REDACTABLE',
      'ACTIVITY_ALREADY_REDACTED',
      // Track 1 T1-b — 1 optimistic-concurrency stale-write refusal on
      // requisition.Requisition (versioned update, version mismatch → 409).
      'REQUISITION_VERSION_CONFLICT',
      // Track 1 T1-e — 1 gated-status server-side refusal (status-changing
      // PATCH into draft | pending_approval | archived → 422).
      'REQUISITION_STATUS_GATED',
      'RESTRICTION_INVALID',
      'RESTRICTION_ALREADY_CLOSED',
      // Track 3 E1-a — 2 PlacementProcess lifecycle refusals (illegal
      // transition 422 + duplicate live attempt 409).
      'PLACEMENT_STATE_INVALID',
      'PLACEMENT_ALREADY_LIVE',
      // Track 3 E2 — 2 pre-start requirement refusals (domain validation 422 +
      // fail-closed READY_TO_START gate 409).
      'PRE_START_REQUIREMENT_INVALID',
      'PRE_START_NOT_READY',
      // Track 3 E3 — 1 governed terminal/fallthrough reason-evidence refusal
      // (one code, details.reason discriminator; 422).
      'PLACEMENT_REASON_INVALID',
      // Track 3 E4 — 1 replacement-linkage refusal (one code, details.reason
      // discriminator: predecessor_not_found | predecessor_not_terminal; 422).
      'PLACEMENT_REPLACEMENT_INVALID',
      // Track 4 T4-A1 — 1 start-context refusal: STARTED needs the assignment org
      // snapshot (company_id) to materialise the FORWARD ContractAssignment (422).
      'PLACEMENT_START_CONTEXT_REQUIRED',
      // Track 5 T5-P1 — 1 commercial-terms-required refusal (STARTED without the
      // actual commercial terms; 422). Atomic — zero mutation.
      'PLACEMENT_START_COMMERCIAL_TERMS_REQUIRED',
      // Track 3 E6 — 1 pipeline one-live-episode refusal (Q-2; 409). Both the
      // deterministic app-guard refusal and the exact-name race-floor translation.
      'PIPELINE_EPISODE_ALREADY_LIVE',
      // Track 3 E6 — 1 pre-flight reconciliation live/live refusal (A4, §5.2; 409).
      'PIPELINE_RECONCILE_LIVE_CONFLICT',
      'REQUISITION_EXTERNAL_IDENTITY_CONFLICT',
      'ASSIGNMENT_COMMERCIAL_REVISION_CONFLICT',
      // Slice #3 — Assignment-Extension forward-only refusal (422).
      'ASSIGNMENT_EXTENSION_NOT_FORWARD',
      // Track 7 / T7-P1 — the PermanentPlacement guarantee family (appended in order).
      'PERMANENT_PLACEMENT_NOT_FOUND',
      'PERMANENT_PLACEMENT_STATE_INVALID',
      'PERMANENT_PLACEMENT_GUARANTEE_WINDOW_INVALID',
      'PERMANENT_PLACEMENT_TERMS_REQUIRED',
      'PERMANENT_PLACEMENT_EXPOSURE_INVALID',
      'PERMANENT_PLACEMENT_ALREADY_EXISTS',
      // Track 7 / T7-P2 — falloff + remedy family (appended in order).
      'PERMANENT_PLACEMENT_FALLOFF_WINDOW_INVALID',
      'PERMANENT_PLACEMENT_FALLOFF_REASON_INVALID',
      'PERMANENT_PLACEMENT_REMEDY_INVALID',
      'PERMANENT_PLACEMENT_REMEDY_ALREADY_COMPLETED',
      'CONNECTOR_CONFIGURATION_INVALID',
      // Track 7 / T7-P3 — guarantee-term-versioning family (appended in order).
      'PERMANENT_PLACEMENT_TERMS_NOT_FOUND',
      'PERMANENT_PLACEMENT_TERMS_WINDOW_INVALID',
      'PERMANENT_PLACEMENT_TERMS_OVERLAP',
      'PERMANENT_PLACEMENT_TERMS_AMBIGUOUS',
      'PERMANENT_PLACEMENT_TERMS_IMMUTABLE',
      'SUBMITTALS_CLOSED',
      'SUBMITTAL_WINDOW_PASSED',
      'SUBMITTAL_LIMIT_REACHED',
      'TALENT_RESTRICTED_AT_CLIENT',
      'PIPELINE_SUBMIT_REQUIRES_SUBMITTAL',
      'SUBMITTAL_PIPELINE_LINK_INVALID',
      'OFFER_ALREADY_LIVE',
      'OFFER_ILLEGAL_TRANSITION',
    ]);
  });
});
