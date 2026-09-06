import { describe, expect, it } from 'vitest';

import {
  decideEngagement,
  isValidOverrideReason,
  type EngagementOverrideRequest,
  type EngagementReadiness,
} from '../index.js';

// COMM PART A — pure enforcement-decision proofs (A4/A5/A6/A7). No I/O, no
// provider awareness; the decision maps enforcement_mode × readiness × override.

const satisfied: EngagementReadiness = {
  satisfied: true,
  results: [{ channel: 'email', required: true, status: 'satisfied' }],
  missing: [],
  unavailable: false,
};
const missingEmail: EngagementReadiness = {
  satisfied: false,
  results: [{ channel: 'email', required: true, status: 'missing' }],
  missing: ['email'],
  unavailable: false,
};
const unavailableVoice: EngagementReadiness = {
  satisfied: false,
  results: [{ channel: 'voice', required: true, status: 'unavailable' }],
  missing: ['voice'],
  unavailable: true,
};

const noOverride: EngagementOverrideRequest = { requested: false, actorHasOverrideScope: false, reason: null };
const authorizedOverride: EngagementOverrideRequest = {
  requested: true,
  actorHasOverrideScope: true,
  reason: 'Client pre-screened this Talent by phone; recorded evidence pending sync.',
};

describe('decideEngagement (enforcement modes)', () => {
  it('satisfied always allows — mode/override are inert', () => {
    for (const mode of ['ADVISORY', 'ENFORCING', 'ENFORCING_WITH_OVERRIDE'] as const) {
      const d = decideEngagement(satisfied, mode, noOverride);
      expect(d.outcome).toBe('ALLOW_SATISFIED');
      expect(d.allow).toBe(true);
      expect(d.proceededIncomplete).toBe(false);
      expect(d.overridden).toBe(false);
    }
  });

  it('ADVISORY + missing → allow, proceeded-incomplete (not satisfied)', () => {
    const d = decideEngagement(missingEmail, 'ADVISORY', noOverride);
    expect(d.outcome).toBe('ALLOW_ADVISORY');
    expect(d.allow).toBe(true);
    expect(d.proceededIncomplete).toBe(true); // advisory_proceed ≠ requirements_satisfied
    expect(d.overridden).toBe(false);
    expect(d.missing).toEqual(['email']);
  });

  it('ENFORCING + missing → block', () => {
    const d = decideEngagement(missingEmail, 'ENFORCING', noOverride);
    expect(d.outcome).toBe('BLOCK_INCOMPLETE');
    expect(d.allow).toBe(false);
  });

  it('ENFORCING + satisfied → allow', () => {
    expect(decideEngagement(satisfied, 'ENFORCING', noOverride).allow).toBe(true);
  });

  it('ENFORCING_WITH_OVERRIDE + no override attempted → block', () => {
    const d = decideEngagement(missingEmail, 'ENFORCING_WITH_OVERRIDE', noOverride);
    expect(d.outcome).toBe('BLOCK_INCOMPLETE');
    expect(d.allow).toBe(false);
  });

  it('override WITHOUT scope → blocked (BLOCK_OVERRIDE_INVALID)', () => {
    const d = decideEngagement(missingEmail, 'ENFORCING_WITH_OVERRIDE', {
      requested: true,
      actorHasOverrideScope: false,
      reason: 'let me through',
    });
    expect(d.outcome).toBe('BLOCK_OVERRIDE_INVALID');
    expect(d.allow).toBe(false);
    expect(d.overridden).toBe(false);
  });

  it('override WITH scope but NO reason → rejected', () => {
    const d = decideEngagement(missingEmail, 'ENFORCING_WITH_OVERRIDE', {
      requested: true,
      actorHasOverrideScope: true,
      reason: '   ',
    });
    expect(d.outcome).toBe('BLOCK_OVERRIDE_INVALID');
    expect(d.allow).toBe(false);
  });

  it('override WITH scope + reason → allowed, overridden, reason carried (trimmed)', () => {
    const d = decideEngagement(missingEmail, 'ENFORCING_WITH_OVERRIDE', authorizedOverride);
    expect(d.outcome).toBe('ALLOW_OVERRIDDEN');
    expect(d.allow).toBe(true);
    expect(d.overridden).toBe(true);
    expect(d.proceededIncomplete).toBe(true);
    expect(d.overrideReason).toBe(authorizedOverride.reason);
  });

  it('override never fabricates evidence — missing set is preserved on an overridden allow', () => {
    const d = decideEngagement(missingEmail, 'ENFORCING_WITH_OVERRIDE', authorizedOverride);
    expect(d.missing).toEqual(['email']); // still recorded as missing, just overridden
  });

  it('read-error (unavailable) is fail-closed even under ADVISORY and is not overridable', () => {
    expect(decideEngagement(unavailableVoice, 'ADVISORY', noOverride).outcome).toBe('BLOCK_UNAVAILABLE');
    expect(decideEngagement(unavailableVoice, 'ENFORCING_WITH_OVERRIDE', authorizedOverride).outcome).toBe(
      'BLOCK_UNAVAILABLE',
    );
  });
});

describe('isValidOverrideReason (A7 bounds)', () => {
  it('rejects null / empty / whitespace', () => {
    expect(isValidOverrideReason(null)).toBe(false);
    expect(isValidOverrideReason('')).toBe(false);
    expect(isValidOverrideReason('    ')).toBe(false);
  });
  it('accepts a bounded human reason', () => {
    expect(isValidOverrideReason('Phone-screened, evidence pending.')).toBe(true);
  });
  it('rejects an over-length reason', () => {
    expect(isValidOverrideReason('x'.repeat(1001))).toBe(false);
  });
});
