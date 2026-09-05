import { describe, expect, it } from 'vitest';
import { computeChecksum } from '@aramo/policy-store';

import {
  assertEngagementPolicyActivatable,
  EngagementPolicyService,
  engagementPackageName,
  validateEngagementPolicyDefinition,
  type EngagementPolicyDefinition,
  type EngagementPolicyGateway,
  type EngagementPolicyScope,
  type EngagementRequirement,
  type StoredPolicyVersionRow,
} from '../index.js';

// COMM-C3 — validation + activation guard (R7) + layered resolution (R11) proofs
// (directive §9 7-11). The persistence gateway is faked; the domain merge is
// exercised directly.

const TENANT = '00000000-0000-7000-8000-0000000000a1';

const voiceReq = (min: 'RECRUITER_ATTESTED' | 'PROVIDER_VERIFIED', required = true): EngagementRequirement => ({
  channel: 'voice',
  required,
  condition: 'two_way_conversation',
  minimum_strength: min,
});
const emailReq = (required: boolean): EngagementRequirement => ({
  channel: 'email',
  required,
  condition: 'recorded_evidence',
});

function def(scope: EngagementPolicyScope, ref: string | null, reqs: EngagementRequirement[]): EngagementPolicyDefinition {
  return { schema_version: 1, scope, scope_ref: ref, requirements: reqs };
}

function row(d: EngagementPolicyDefinition, version: string): StoredPolicyVersionRow {
  return {
    package_name: engagementPackageName(d.scope, d.scope_ref),
    version,
    definition: d,
    checksum: computeChecksum(d),
    effective_from: new Date('2026-01-01T00:00:00Z'),
    effective_to: null,
    published_by: TENANT,
    published_at: new Date('2026-01-01T00:00:00Z'),
  };
}

function fakeGateway(rows: StoredPolicyVersionRow[]): EngagementPolicyGateway {
  return {
    async findVersionRows(_tenant, packageNames) {
      return rows.filter((r) => packageNames.includes(r.package_name));
    },
    async tenantHasAnyEngagementPolicy() {
      return rows.length > 0;
    },
    async insertVersion() {
      throw new Error('not used');
    },
  };
}

describe('validation + activation guard (R7)', () => {
  it('accepts a well-formed voice policy', () => {
    expect(() => validateEngagementPolicyDefinition(def('TENANT', null, [voiceReq('RECRUITER_ATTESTED')]))).not.toThrow();
  });

  it('rejects an email-REQUIRED policy from activation (no producer, R7)', () => {
    expect(() => assertEngagementPolicyActivatable(def('TENANT', null, [emailReq(true)]))).toThrowError(
      /not be activated|no evidence producer/i,
    );
  });

  it('allows an email requirement with required=false', () => {
    expect(() => assertEngagementPolicyActivatable(def('TENANT', null, [emailReq(false)]))).not.toThrow();
  });

  it('rejects a duplicate channel in one document', () => {
    expect(() =>
      validateEngagementPolicyDefinition(def('TENANT', null, [voiceReq('RECRUITER_ATTESTED'), voiceReq('PROVIDER_VERIFIED')])),
    ).toThrow();
  });
});

describe('layered resolution TENANT→CLIENT→REQUISITION (R11)', () => {
  const COMPANY = '00000000-0000-7000-8000-0000000000c1';
  const REQ = '00000000-0000-7000-8000-0000000000r1';

  it('returns null when no layer has a published policy', async () => {
    const svc = new EngagementPolicyService(fakeGateway([]));
    expect(await svc.resolveEffective(TENANT, { company_id: COMPANY, requisition_id: REQ })).toBeNull();
  });

  it('TENANT policy resolves', async () => {
    const svc = new EngagementPolicyService(fakeGateway([row(def('TENANT', null, [voiceReq('RECRUITER_ATTESTED')]), 'v1')]));
    const eff = await svc.resolveEffective(TENANT, {});
    expect(eff?.requirements).toHaveLength(1);
    expect(eff?.layers.map((l) => l.scope)).toEqual(['TENANT']);
  });

  it('CLIENT overrides the same channel and augments (over TENANT)', async () => {
    const svc = new EngagementPolicyService(
      fakeGateway([
        row(def('TENANT', null, [voiceReq('RECRUITER_ATTESTED')]), 'v1'),
        row(def('CLIENT', COMPANY, [voiceReq('PROVIDER_VERIFIED'), emailReq(false)]), 'v1'),
      ]),
    );
    const eff = await svc.resolveEffective(TENANT, { company_id: COMPANY });
    const voice = eff?.requirements.find((r) => r.channel === 'voice');
    expect(voice?.channel === 'voice' && voice.minimum_strength).toBe('PROVIDER_VERIFIED'); // CLIENT wins
    expect(eff?.requirements.some((r) => r.channel === 'email')).toBe(true); // augmented
    expect(eff?.layers.map((l) => l.scope)).toEqual(['TENANT', 'CLIENT']);
  });

  it('REQUISITION overrides CLIENT and TENANT (most specific wins)', async () => {
    const svc = new EngagementPolicyService(
      fakeGateway([
        row(def('TENANT', null, [voiceReq('RECRUITER_ATTESTED')]), 'v1'),
        row(def('CLIENT', COMPANY, [voiceReq('PROVIDER_VERIFIED')]), 'v1'),
        row(def('REQUISITION', REQ, [voiceReq('RECRUITER_ATTESTED')]), 'v1'),
      ]),
    );
    const eff = await svc.resolveEffective(TENANT, { company_id: COMPANY, requisition_id: REQ });
    const voice = eff?.requirements.find((r) => r.channel === 'voice');
    expect(voice?.channel === 'voice' && voice.minimum_strength).toBe('RECRUITER_ATTESTED'); // REQUISITION wins
    expect(eff?.layers.map((l) => l.scope)).toEqual(['TENANT', 'CLIENT', 'REQUISITION']);
  });
});
