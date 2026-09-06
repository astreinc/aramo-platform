import { describe, expect, it, vi } from 'vitest';
import { computeChecksum } from '@aramo/policy-store';
import {
  EngagementPolicyService,
  engagementPackageName,
  type EngagementEvidenceFact,
  type EngagementPolicyDefinition,
  type EngagementPolicyGateway,
  type StoredPolicyVersionRow,
} from '@aramo/engagement';

import { EngagementGateService } from '../engagement/engagement-gate.service.js';

// COMM PART A — the composition-root gate: enforcement modes + authoritative
// override provenance (A4/A5/A6/A8). EngagementPolicyService is driven with a
// fake gateway; the evidence reader + policy_store db are mocked.

const TENANT = '00000000-0000-7000-8000-0000000000a1';
const TALENT = '00000000-0000-7000-8000-0000000000b1';
const REQ = '00000000-0000-7000-8000-0000000000d1';

function emailPolicyRow(mode: EngagementPolicyDefinition['enforcement_mode']): StoredPolicyVersionRow {
  const def: EngagementPolicyDefinition = {
    schema_version: 1,
    scope: 'TENANT',
    scope_ref: null,
    requirements: [{ channel: 'email', required: true, condition: 'recorded_evidence' }],
    ...(mode ? { enforcement_mode: mode } : {}),
  };
  return {
    package_name: engagementPackageName('TENANT', null),
    version: 'v1',
    definition: def,
    checksum: computeChecksum(def),
    effective_from: new Date('2026-01-01T00:00:00Z'),
    effective_to: null,
    published_by: TENANT,
    published_at: new Date('2026-01-01T00:00:00Z'),
  };
}

function gateway(rows: StoredPolicyVersionRow[]): EngagementPolicyGateway {
  return {
    async findVersionRows(_t, pkgs) {
      return rows.filter((r) => pkgs.includes(r.package_name));
    },
    async tenantHasAnyEngagementPolicy() {
      return rows.length > 0;
    },
    async insertVersion() {
      throw new Error('not used');
    },
  };
}

const emailMissing: EngagementEvidenceFact[] = [{ channel: 'email', availability: 'available', recorded_evidence: false }];
const emailPresent: EngagementEvidenceFact[] = [{ channel: 'email', availability: 'available', recorded_evidence: true }];

function makeGate(rows: StoredPolicyVersionRow[], facts: EngagementEvidenceFact[], db?: { $executeRawUnsafe: ReturnType<typeof vi.fn> }) {
  const policy = new EngagementPolicyService(gateway(rows));
  const reader = { readFacts: vi.fn().mockResolvedValue(facts) };
  const rawDb = db ?? { $executeRawUnsafe: vi.fn().mockResolvedValue(1) };
  return { gate: new EngagementGateService(policy, reader as never, rawDb as never), rawDb };
}

const base = { tenant_id: TENANT, talent_id: TALENT, requisition_id: REQ, submittal_id: 'sub-1', company_id: null, actor_id: TENANT, correlation_id: 'corr-1' };

describe('EngagementGateService — enforcement modes', () => {
  it('dormant tenant (no policy, never governed) → allow, NO provenance write', async () => {
    const { gate, rawDb } = makeGate([], []);
    const r = await gate.assess({ ...base });
    expect(r.satisfied).toBe(true);
    expect(rawDb.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('ADVISORY + missing email → allow (satisfied) + provenance ALLOW_ADVISORY', async () => {
    const { gate, rawDb } = makeGate([emailPolicyRow('ADVISORY')], emailMissing);
    const r = await gate.assess({ ...base });
    expect(r.satisfied).toBe(true);
    const call = rawDb.$executeRawUnsafe.mock.calls[0]!;
    expect(call[5]).toBe('ENGAGEMENT_ADVISORY_PROCEED'); // reason_code position
    const inputs = JSON.parse(call[8] as string);
    expect(inputs.enforcement_mode).toBe('ADVISORY');
    expect(inputs.proceeded_incomplete).toBe(true);
  });

  it('ENFORCING + missing → deny INCOMPLETE', async () => {
    const { gate } = makeGate([emailPolicyRow('ENFORCING')], emailMissing);
    const r = await gate.assess({ ...base });
    expect(r.satisfied).toBe(false);
    expect(r.deny).toBe('CLIENT_SUBMITTAL_ENGAGEMENT_INCOMPLETE');
  });

  it('ENFORCING + satisfied → allow', async () => {
    const { gate } = makeGate([emailPolicyRow('ENFORCING')], emailPresent);
    expect((await gate.assess({ ...base })).satisfied).toBe(true);
  });

  it('legacy policy (no mode) + missing → ENFORCING deny (backward-compat)', async () => {
    const { gate } = makeGate([emailPolicyRow(undefined)], emailMissing);
    expect((await gate.assess({ ...base })).satisfied).toBe(false);
  });

  it('ENFORCING_WITH_OVERRIDE + missing + NO override attempt → deny', async () => {
    const { gate } = makeGate([emailPolicyRow('ENFORCING_WITH_OVERRIDE')], emailMissing);
    expect((await gate.assess({ ...base })).satisfied).toBe(false);
  });

  it('override WITHOUT scope → deny (no allow)', async () => {
    const { gate } = makeGate([emailPolicyRow('ENFORCING_WITH_OVERRIDE')], emailMissing);
    const r = await gate.assess({ ...base, actor_can_override: false, override: { reason: 'let me through' } });
    expect(r.satisfied).toBe(false);
  });

  it('override WITH scope + reason → allow + authoritative provenance carrying the reason', async () => {
    const { gate, rawDb } = makeGate([emailPolicyRow('ENFORCING_WITH_OVERRIDE')], emailMissing);
    const r = await gate.assess({
      ...base,
      actor_can_override: true,
      override: { reason: 'Client phone-screened; evidence sync pending.' },
    });
    expect(r.satisfied).toBe(true);
    const inputs = JSON.parse(rawDb.$executeRawUnsafe.mock.calls[0]![8] as string);
    expect(inputs.overridden).toBe(true);
    expect(inputs.override_reason).toBe('Client phone-screened; evidence sync pending.');
    expect(inputs.missing).toEqual(['email']); // evidence never fabricated
    expect(rawDb.$executeRawUnsafe.mock.calls[0]![5]).toBe('ENGAGEMENT_OVERRIDDEN');
  });

  it('override provenance is AUTHORITATIVE — a write failure fails closed (throws)', async () => {
    const failingDb = { $executeRawUnsafe: vi.fn().mockRejectedValue(new Error('audit down')) };
    const { gate } = makeGate([emailPolicyRow('ENFORCING_WITH_OVERRIDE')], emailMissing, failingDb);
    await expect(
      gate.assess({ ...base, actor_can_override: true, override: { reason: 'valid reason here' } }),
    ).rejects.toThrow(/audit down/);
  });

  it('non-override provenance write failure does NOT block the decision (best-effort)', async () => {
    const failingDb = { $executeRawUnsafe: vi.fn().mockRejectedValue(new Error('audit down')) };
    const { gate } = makeGate([emailPolicyRow('ENFORCING')], emailMissing, failingDb);
    const r = await gate.assess({ ...base });
    expect(r.satisfied).toBe(false); // deny still stands despite audit failure
  });
});
