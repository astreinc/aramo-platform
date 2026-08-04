import { describe, expect, it } from 'vitest';

import {
  AUDIT_ACTION_VALUES,
  REQUIREMENT_STATUS_VALUES,
  REQUIREMENT_TYPE_VALUES,
  SCOPE_TYPE_VALUES,
  WAIVER_AUTHORITY_VALUES,
  WAIVER_MODE_VALUES,
  canMoveStatus,
  canonicalizeDefinitions,
  checksumDefinitions,
  isReopen,
  isResolvedStatus,
  isUnresolvedStatus,
  isWaiverPermitted,
  requiredAuthorityFor,
  type RequirementDefinitionInput,
} from '../lib/pre-start-requirement-vocab.js';

// Track 3 / E2 — closed-registry + pure-logic unit proofs (run without a DB).

describe('E2 closed registries', () => {
  it('ratifies the exact seven-value requirement-type registry (PO 2026-08-04)', () => {
    expect([...REQUIREMENT_TYPE_VALUES]).toEqual([
      'BACKGROUND_CHECK',
      'DRUG_SCREEN',
      'I9_VERIFICATION',
      'CREDENTIAL_VERIFICATION',
      'BADGE_PROVISIONING',
      'CLIENT_PAPERWORK',
      'NDA',
    ]);
  });

  it('scope is TENANT-only (§4b)', () => {
    expect([...SCOPE_TYPE_VALUES]).toEqual(['TENANT']);
  });

  it('has the compact governed status set (REOPENED is an action, not a status)', () => {
    expect([...REQUIREMENT_STATUS_VALUES]).toEqual([
      'PENDING',
      'IN_PROGRESS',
      'SATISFIED',
      'FAILED',
      'WAIVED',
      'CANCELED',
    ]);
    expect(REQUIREMENT_STATUS_VALUES).not.toContain('REOPENED');
    expect(AUDIT_ACTION_VALUES).toContain('REOPENED');
  });

  it('has the four waiver modes and three authority classes', () => {
    expect([...WAIVER_MODE_VALUES]).toEqual([
      'NOT_WAIVABLE',
      'CLIENT_AUTHORITY_ONLY',
      'COMPLIANCE_AUTHORITY_ONLY',
      'AUTHORIZED_INTERNAL',
    ]);
    expect([...WAIVER_AUTHORITY_VALUES]).toEqual(['CLIENT', 'COMPLIANCE', 'INTERNAL']);
  });
});

describe('status resolution classification', () => {
  it('RESOLVED = SATISFIED | WAIVED | CANCELED', () => {
    expect(isResolvedStatus('SATISFIED')).toBe(true);
    expect(isResolvedStatus('WAIVED')).toBe(true);
    expect(isResolvedStatus('CANCELED')).toBe(true);
    expect(isResolvedStatus('FAILED')).toBe(false);
    expect(isUnresolvedStatus('PENDING')).toBe(true);
    expect(isUnresolvedStatus('IN_PROGRESS')).toBe(true);
    expect(isUnresolvedStatus('FAILED')).toBe(true);
  });
});

describe('legal status moves + reopen detection', () => {
  it('permits the forward operational moves', () => {
    expect(canMoveStatus('PENDING', 'IN_PROGRESS')).toBe(true);
    expect(canMoveStatus('PENDING', 'SATISFIED')).toBe(true);
    expect(canMoveStatus('IN_PROGRESS', 'SATISFIED')).toBe(true);
    expect(canMoveStatus('FAILED', 'SATISFIED')).toBe(true);
  });

  it('rejects illegal moves', () => {
    expect(canMoveStatus('SATISFIED', 'IN_PROGRESS')).toBe(false);
    expect(canMoveStatus('CANCELED', 'SATISFIED')).toBe(false);
    expect(canMoveStatus('IN_PROGRESS', 'PENDING')).toBe(false);
  });

  it('classifies a move to PENDING from a resolved/failed status as a reopen', () => {
    expect(isReopen('SATISFIED', 'PENDING')).toBe(true);
    expect(isReopen('WAIVED', 'PENDING')).toBe(true);
    expect(isReopen('FAILED', 'PENDING')).toBe(true);
    expect(isReopen('IN_PROGRESS', 'PENDING')).toBe(false);
    expect(isReopen('PENDING', 'PENDING')).toBe(false);
  });
});

describe('waiver permission — the domain floor is snapshot-anchored', () => {
  it('NOT_WAIVABLE requires no authority and can NEVER be waived', () => {
    expect(requiredAuthorityFor('NOT_WAIVABLE')).toBeNull();
    expect(isWaiverPermitted('NOT_WAIVABLE', 'CLIENT')).toBe(false);
    expect(isWaiverPermitted('NOT_WAIVABLE', 'COMPLIANCE')).toBe(false);
    expect(isWaiverPermitted('NOT_WAIVABLE', 'INTERNAL')).toBe(false);
  });

  it('each waivable mode requires exactly its authority class', () => {
    expect(isWaiverPermitted('CLIENT_AUTHORITY_ONLY', 'CLIENT')).toBe(true);
    expect(isWaiverPermitted('CLIENT_AUTHORITY_ONLY', 'COMPLIANCE')).toBe(false);
    expect(isWaiverPermitted('COMPLIANCE_AUTHORITY_ONLY', 'COMPLIANCE')).toBe(true);
    expect(isWaiverPermitted('COMPLIANCE_AUTHORITY_ONLY', 'INTERNAL')).toBe(false);
    expect(isWaiverPermitted('AUTHORIZED_INTERNAL', 'INTERNAL')).toBe(true);
    expect(isWaiverPermitted('AUTHORIZED_INTERNAL', 'CLIENT')).toBe(false);
  });
});

describe('definition checksum determinism', () => {
  const defs: RequirementDefinitionInput[] = [
    { requirement_type: 'BACKGROUND_CHECK', label: 'BGC', blocking: true, owner_role: null, sequence: 1, waiver_mode: 'NOT_WAIVABLE' },
    { requirement_type: 'NDA', label: 'NDA', blocking: false, owner_role: 'recruiter', sequence: 2, waiver_mode: 'AUTHORIZED_INTERNAL' },
  ];

  it('is order-independent (canonical serialization sorts by sequence)', () => {
    expect(checksumDefinitions(defs)).toEqual(checksumDefinitions([...defs].reverse()));
  });

  it('changes when a governing field (waiver_mode) changes', () => {
    const mutated = [{ ...defs[0]!, waiver_mode: 'CLIENT_AUTHORITY_ONLY' as const }, defs[1]!];
    expect(checksumDefinitions(mutated)).not.toEqual(checksumDefinitions(defs));
  });

  it('produces a 64-hex SHA-256 digest', () => {
    expect(checksumDefinitions(defs)).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalizeDefinitions(defs)).toContain('BACKGROUND_CHECK');
  });
});
