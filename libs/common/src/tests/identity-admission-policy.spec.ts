import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  IDENTITY_ADMISSION_POLICIES,
  loadIdentityAdmissionPolicy,
} from '../index.js';

// TR-2b B1 (§1) — the admission-policy loader is fail-loud, exactly like the
// pepper loader (identity-fingerprint.spec.ts). An undeclared or garbage policy
// must STOP the mint path, never default — D15's declared-gate requirement.

const VAR = 'ARAMO_IDENTITY_ADMISSION_POLICY';

describe('loadIdentityAdmissionPolicy (fail-loud env binding)', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[VAR];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[VAR];
    else process.env[VAR] = saved;
  });

  it('throws (naming the env var) when unset', () => {
    delete process.env[VAR];
    expect(() => loadIdentityAdmissionPolicy()).toThrowError(new RegExp(VAR));
  });

  it('throws when set to the empty string', () => {
    process.env[VAR] = '';
    expect(() => loadIdentityAdmissionPolicy()).toThrowError(new RegExp(VAR));
  });

  it('throws on a value outside the closed vocabulary', () => {
    process.env[VAR] = 'EVERYTHING';
    expect(() => loadIdentityAdmissionPolicy()).toThrowError(/unknown value/);
  });

  it('is case-sensitive — a lowercased valid token is still rejected', () => {
    process.env[VAR] = 'portable_only';
    expect(() => loadIdentityAdmissionPolicy()).toThrowError(/unknown value/);
  });

  it('returns PORTABLE_ONLY when set to PORTABLE_ONLY', () => {
    process.env[VAR] = 'PORTABLE_ONLY';
    expect(loadIdentityAdmissionPolicy()).toBe('PORTABLE_ONLY');
  });

  it('returns ALL_ARRIVALS when set to ALL_ARRIVALS', () => {
    process.env[VAR] = 'ALL_ARRIVALS';
    expect(loadIdentityAdmissionPolicy()).toBe('ALL_ARRIVALS');
  });

  it('exposes a closed vocabulary of exactly [PORTABLE_ONLY, ALL_ARRIVALS]', () => {
    expect([...IDENTITY_ADMISSION_POLICIES]).toEqual([
      'PORTABLE_ONLY',
      'ALL_ARRIVALS',
    ]);
  });
});
