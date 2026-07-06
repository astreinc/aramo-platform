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

  it('ERROR_CODES contains the 42 codes (37 pre-AUTHZ-2 + 3 AUTHZ-2 + 1 AUTHZ-D4a + 1 TR-2a-B3a)', () => {
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
      'ENGAGEMENT_EVENT_REF_NOT_FOUND',
      'ENGAGEMENT_REFERENCE_NOT_FOUND',
      'ENGAGEMENT_STATE_INVALID',
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
    ]);
  });
});
