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

function defMode(
  scope: EngagementPolicyScope,
  ref: string | null,
  reqs: EngagementRequirement[],
  mode: EngagementPolicyDefinition['enforcement_mode'],
): EngagementPolicyDefinition {
  return { schema_version: 1, scope, scope_ref: ref, requirements: reqs, ...(mode ? { enforcement_mode: mode } : {}) };
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

  it('allows an email-REQUIRED policy to activate now that a real producer exists (COMM-C2B)', () => {
    // C2B-9 flipped email capability → available (real Graph producer + read).
    expect(() => assertEngagementPolicyActivatable(def('TENANT', null, [emailReq(true)]))).not.toThrow();
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

describe('enforcement_mode resolution (PART A / A2 backward-compat)', () => {
  const COMPANY = '00000000-0000-7000-8000-0000000000c1';
  const REQ = '00000000-0000-7000-8000-0000000000r1';

  it('a legacy policy WITHOUT enforcement_mode resolves to ENFORCING (never ADVISORY)', async () => {
    const svc = new EngagementPolicyService(fakeGateway([row(def('TENANT', null, [emailReq(true)]), 'v1')]));
    const eff = await svc.resolveEffective(TENANT, {});
    expect(eff?.enforcement_mode).toBe('ENFORCING');
  });

  it('an explicit ADVISORY tenant policy resolves ADVISORY', async () => {
    const svc = new EngagementPolicyService(
      fakeGateway([row(defMode('TENANT', null, [emailReq(true)], 'ADVISORY'), 'v1')]),
    );
    expect((await svc.resolveEffective(TENANT, {}))?.enforcement_mode).toBe('ADVISORY');
  });

  it('the MOST-SPECIFIC layer mode wins (TENANT ADVISORY, REQUISITION ENFORCING_WITH_OVERRIDE)', async () => {
    const svc = new EngagementPolicyService(
      fakeGateway([
        row(defMode('TENANT', null, [voiceReq('RECRUITER_ATTESTED')], 'ADVISORY'), 'v1'),
        row(defMode('REQUISITION', REQ, [voiceReq('RECRUITER_ATTESTED')], 'ENFORCING_WITH_OVERRIDE'), 'v1'),
      ]),
    );
    const eff = await svc.resolveEffective(TENANT, { company_id: COMPANY, requisition_id: REQ });
    expect(eff?.enforcement_mode).toBe('ENFORCING_WITH_OVERRIDE');
  });

  it('a more-specific layer WITHOUT a mode falls back to ENFORCING even if a broader layer was ADVISORY', async () => {
    const svc = new EngagementPolicyService(
      fakeGateway([
        row(defMode('TENANT', null, [voiceReq('RECRUITER_ATTESTED')], 'ADVISORY'), 'v1'),
        row(def('REQUISITION', REQ, [voiceReq('RECRUITER_ATTESTED')]), 'v1'), // no mode → ENFORCING
      ]),
    );
    const eff = await svc.resolveEffective(TENANT, { company_id: COMPANY, requisition_id: REQ });
    expect(eff?.enforcement_mode).toBe('ENFORCING');
  });
});

describe('read-side provenance / raw layers / history (PA-2b)', () => {
  const COMPANY = '00000000-0000-7000-8000-0000000000c1';
  const pkgTenant = engagementPackageName('TENANT', null);

  it('resolveEffectiveView: inherited channel + client-overridden channel + effective enforcement_mode', async () => {
    const svc = new EngagementPolicyService(
      fakeGateway([
        row(def('TENANT', null, [voiceReq('RECRUITER_ATTESTED'), emailReq(false)]), 'v1'),
        row(defMode('CLIENT', COMPANY, [voiceReq('PROVIDER_VERIFIED')], 'ENFORCING_WITH_OVERRIDE'), 'v1'),
      ]),
    );
    const view = await svc.resolveEffectiveView(TENANT, { company_id: COMPANY });
    const byCh = Object.fromEntries((view?.requirements ?? []).map((r) => [r.channel, r]));
    expect(byCh['voice']!.source.scope).toBe('CLIENT');
    expect(byCh['voice']!.provenance).toEqual({ inherited: false, client_override: true, client_added: false });
    expect(byCh['email']!.source.scope).toBe('TENANT');
    expect(byCh['email']!.provenance).toEqual({ inherited: true, client_override: false, client_added: false });
    expect(view?.enforcement_mode).toBe('ENFORCING_WITH_OVERRIDE');
    expect(view?.layers.map((l) => l.scope)).toEqual(['TENANT', 'CLIENT']);
  });

  it('resolveEffectiveView: a client-added channel is flagged client_added', async () => {
    const svc = new EngagementPolicyService(
      fakeGateway([
        row(def('TENANT', null, [voiceReq('RECRUITER_ATTESTED')]), 'v1'),
        row(def('CLIENT', COMPANY, [emailReq(true)]), 'v1'),
      ]),
    );
    const view = await svc.resolveEffectiveView(TENANT, { company_id: COMPANY });
    const byCh = Object.fromEntries((view?.requirements ?? []).map((r) => [r.channel, r]));
    expect(byCh['voice']!.provenance.inherited).toBe(true);
    expect(byCh['email']!.source.scope).toBe('CLIENT');
    expect(byCh['email']!.provenance).toEqual({ inherited: false, client_override: false, client_added: true });
  });

  it('resolveEffective (decision path) shape unchanged — raw merged requirements + enforcement_mode', async () => {
    const svc = new EngagementPolicyService(
      fakeGateway([
        row(def('TENANT', null, [voiceReq('RECRUITER_ATTESTED'), emailReq(false)]), 'v1'),
        row(defMode('CLIENT', COMPANY, [voiceReq('PROVIDER_VERIFIED')], 'ENFORCING_WITH_OVERRIDE'), 'v1'),
      ]),
    );
    const eff = await svc.resolveEffective(TENANT, { company_id: COMPANY });
    expect(eff?.requirements.map((r) => r.channel).sort()).toEqual(['email', 'voice']);
    expect(eff?.requirements.find((r) => r.channel === 'voice')?.minimum_strength).toBe('PROVIDER_VERIFIED');
    expect(eff?.enforcement_mode).toBe('ENFORCING_WITH_OVERRIDE');
    const view = await svc.resolveEffectiveView(TENANT, { company_id: COMPANY });
    expect(eff?.composite_version).toBe(view?.composite_version);
  });

  it('readLayers: raw tenant + client defs (+ per-layer enforcement_mode) + merged effective', async () => {
    const svc = new EngagementPolicyService(
      fakeGateway([
        row(def('TENANT', null, [voiceReq('RECRUITER_ATTESTED'), emailReq(false)]), 'v1'),
        row(defMode('CLIENT', COMPANY, [voiceReq('PROVIDER_VERIFIED')], 'ENFORCING_WITH_OVERRIDE'), 'v1'),
      ]),
    );
    const layers = await svc.readLayers(TENANT, { company_id: COMPANY });
    expect(layers.tenant.present).toBe(true);
    expect(layers.tenant.requirements.map((r) => r.channel).sort()).toEqual(['email', 'voice']);
    expect(layers.client?.present).toBe(true);
    expect(layers.client?.enforcement_mode).toBe('ENFORCING_WITH_OVERRIDE');
    expect(layers.requisition).toBeNull();
    expect(layers.effective?.requirements.length).toBe(2);
  });

  it('readLayers: an absent client layer is marked not-present', async () => {
    const svc = new EngagementPolicyService(fakeGateway([row(def('TENANT', null, [voiceReq('RECRUITER_ATTESTED')]), 'v1')]));
    const layers = await svc.readLayers(TENANT, { company_id: COMPANY });
    expect(layers.client?.present).toBe(false);
    expect(layers.client?.requirements).toEqual([]);
  });

  it('history: versions newest first with lifecycle status', async () => {
    const d = def('TENANT', null, [voiceReq('RECRUITER_ATTESTED')]);
    const mk = (version: string, from: string, to: string | null): StoredPolicyVersionRow => ({
      package_name: pkgTenant, version, definition: d, checksum: computeChecksum(d),
      effective_from: new Date(from), effective_to: to === null ? null : new Date(to),
      published_by: TENANT, published_at: new Date(from),
    });
    const svc = new EngagementPolicyService(
      fakeGateway([mk('v1', '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z'), mk('v2', '2026-06-01T00:00:00Z', null)]),
    );
    const hist = await svc.history(TENANT, 'TENANT', null, new Date('2026-09-01T00:00:00Z'));
    expect(hist.map((h) => h.version)).toEqual(['v2', 'v1']);
    expect(hist[0]!.status).toBe('current');
    expect(hist[1]!.status).toBe('superseded');
  });
});
