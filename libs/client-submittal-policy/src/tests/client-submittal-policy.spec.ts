import { describe, it, expect } from 'vitest';
import { validatePackage } from '@aramo/policy-engine';

import {
  checksumDefinition,
  type ClientSubmittalPolicyDefinition,
  type ClientSubmittalRequirement,
  type Disposition,
  type OverrideClass,
  type OverridePolicy,
} from '../lib/client-submittal-vocab.js';
import { floorViolation, joinFloor } from '../lib/client-submittal-floor.js';
import { compileEffectivePackage, CLIENT_SUBMITTAL_OVERRIDE_CAPABILITY } from '../lib/client-submittal-compiler.js';
import {
  type ClientSubmittalPolicyGateway,
  type InsertClientSubmittalVersionInput,
  type StoredPolicyVersionRow,
  clientSubmittalPackageName,
} from '../lib/client-submittal-policy.gateway.js';
import { ClientSubmittalPolicyService } from '../lib/client-submittal-policy.service.js';

const req = (
  key: ClientSubmittalRequirement['key'],
  disposition: Disposition,
  override_class: OverrideClass,
  override_policy: OverridePolicy = 'DEFAULT',
): ClientSubmittalRequirement => ({ key, disposition, override_class, override_policy });

const def = (...requirements: ClientSubmittalRequirement[]): ClientSubmittalPolicyDefinition => ({ requirements });

function row(pkg: string, version: string, d: ClientSubmittalPolicyDefinition, from?: Date, to?: Date | null): StoredPolicyVersionRow {
  return {
    package_name: pkg,
    version,
    definition: d,
    checksum: checksumDefinition(d),
    effective_from: from ?? new Date('2020-01-01T00:00:00Z'),
    effective_to: to ?? null,
    published_by: 'system',
    published_at: from ?? new Date('2020-01-01T00:00:00Z'),
  };
}

class FakeGateway implements ClientSubmittalPolicyGateway {
  constructor(private readonly rows: StoredPolicyVersionRow[]) {}
  findVersionRows(_tenantId: string, packageNames: readonly string[]): Promise<StoredPolicyVersionRow[]> {
    return Promise.resolve(this.rows.filter((r) => packageNames.includes(r.package_name)));
  }
  insertVersion(_input: InsertClientSubmittalVersionInput): Promise<StoredPolicyVersionRow> {
    throw new Error('not exercised in the resolver spec');
  }
}

const TENANT = 't1';
const COMPANY_A = 'company-a';
const COMPANY_B = 'company-b';
const REQ = 'req-1';
const pkgTenant = clientSubmittalPackageName('TENANT', null);

describe('checksum identity — every field participates', () => {
  it('DEFAULT vs FLOOR, disposition and override_class changes each yield a distinct checksum', () => {
    const base = def(req('resume_selected', 'REQUIRED', 'HARD_DENY', 'DEFAULT'));
    const asFloor = def(req('resume_selected', 'REQUIRED', 'HARD_DENY', 'FLOOR'));
    const asNotReq = def(req('resume_selected', 'NOT_REQUIRED', 'HARD_DENY', 'DEFAULT'));
    const asOverridable = def(req('resume_selected', 'REQUIRED', 'OVERRIDABLE', 'DEFAULT'));
    const s = new Set([checksumDefinition(base), checksumDefinition(asFloor), checksumDefinition(asNotReq), checksumDefinition(asOverridable)]);
    expect(s.size).toBe(4);
  });
});

describe('FLOOR strictness comparators', () => {
  it('disposition REQUIRED is stricter than NOT_REQUIRED', () => {
    expect(floorViolation(req('resume_selected', 'NOT_REQUIRED', 'HARD_DENY', 'FLOOR'), req('resume_selected', 'REQUIRED', 'HARD_DENY', 'FLOOR'))).toBe('disposition');
    expect(floorViolation(req('resume_selected', 'REQUIRED', 'HARD_DENY'), req('resume_selected', 'REQUIRED', 'HARD_DENY'))).toBeNull();
  });
  it('override_class HARD_DENY > OVERRIDABLE > AUDIT_ONLY (weakening flagged)', () => {
    expect(floorViolation(req('resume_selected', 'REQUIRED', 'OVERRIDABLE'), req('resume_selected', 'REQUIRED', 'HARD_DENY'))).toBe('override_class');
    expect(floorViolation(req('resume_selected', 'REQUIRED', 'HARD_DENY'), req('resume_selected', 'REQUIRED', 'OVERRIDABLE'))).toBeNull();
  });
  it('joinFloor accumulates the strictest', () => {
    const j = joinFloor(req('resume_selected', 'NOT_REQUIRED', 'AUDIT_ONLY', 'FLOOR'), req('resume_selected', 'REQUIRED', 'HARD_DENY', 'DEFAULT'));
    expect(j).toEqual(req('resume_selected', 'REQUIRED', 'HARD_DENY', 'FLOOR'));
  });
});

describe('compiler', () => {
  it('produces a package that passes the generic validatePackage', () => {
    const pkg = compileEffectivePackage(def(req('resume_selected', 'REQUIRED', 'HARD_DENY')), 'v1');
    expect(() => validatePackage(pkg)).not.toThrow();
  });
  it('REQUIRED emits a rule; NOT_REQUIRED emits NO rule', () => {
    const pkg = compileEffectivePackage(def(req('resume_selected', 'REQUIRED', 'HARD_DENY'), req('bill_rate_present', 'NOT_REQUIRED', 'HARD_DENY')), 'v1');
    expect(pkg.rules.map((r) => r.id)).toEqual(['require-resume_selected']);
  });
  it('override_class maps to the runtime Decision', () => {
    const pkg = compileEffectivePackage(
      def(req('resume_selected', 'REQUIRED', 'HARD_DENY'), req('rtr_present', 'REQUIRED', 'OVERRIDABLE'), req('bill_rate_present', 'REQUIRED', 'AUDIT_ONLY')),
      'v1',
    );
    const byId = Object.fromEntries(pkg.rules.map((r) => [r.id, r]));
    expect(byId['require-resume_selected']?.decision).toBe('DENY');
    expect(byId['require-rtr_present']?.decision).toBe('REQUIRES_OVERRIDE');
    expect(byId['require-rtr_present']?.required_capability).toBe(CLIENT_SUBMITTAL_OVERRIDE_CAPABILITY);
    expect(byId['require-bill_rate_present']?.decision).toBe('ALLOW_WITH_AUDIT');
  });
});

describe('resolveEffective + decide', () => {
  it('client A vs client B — same facts, divergent verdict (grounded on work_authorization_present)', async () => {
    const svc = new ClientSubmittalPolicyService(
      new FakeGateway([
        row(pkgTenant, 'v1', def(req('resume_selected', 'REQUIRED', 'HARD_DENY'))),
        row(clientSubmittalPackageName('CLIENT', COMPANY_A), 'v1', def(req('work_authorization_present', 'REQUIRED', 'HARD_DENY'))),
        // Company B has no CLIENT layer.
      ]),
    );
    const facts = { resume_selected: true, work_authorization_present: false };
    const effA = await svc.resolveEffective(TENANT, { company_id: COMPANY_A, requisition_id: null });
    const effB = await svc.resolveEffective(TENANT, { company_id: COMPANY_B, requisition_id: null });
    expect(svc.decide(TENANT, effA!, facts, 'c').decision).toBe('DENY');
    expect(svc.decide(TENANT, effB!, facts, 'c').decision).toBe('ALLOW');
  });

  it('REQUISITION augments over CLIENT', async () => {
    const svc = new ClientSubmittalPolicyService(
      new FakeGateway([
        row(pkgTenant, 'v1', def(req('resume_selected', 'REQUIRED', 'HARD_DENY'))),
        row(clientSubmittalPackageName('CLIENT', COMPANY_A), 'v1', def(req('work_authorization_present', 'REQUIRED', 'HARD_DENY'))),
        row(clientSubmittalPackageName('REQUISITION', REQ), 'v1', def(req('bill_rate_present', 'REQUIRED', 'HARD_DENY'))),
      ]),
    );
    const eff = await svc.resolveEffective(TENANT, { company_id: COMPANY_A, requisition_id: REQ });
    expect(eff!.requirements.map((r) => r.key).sort()).toEqual(['bill_rate_present', 'resume_selected', 'work_authorization_present']);
    expect(eff!.layers.map((l) => l.scope)).toEqual(['TENANT', 'CLIENT', 'REQUISITION']);
  });

  it('FLOOR — a CLIENT layer weakening a TENANT FLOOR is rejected fail-closed', async () => {
    const svc = new ClientSubmittalPolicyService(
      new FakeGateway([
        row(pkgTenant, 'v1', def(req('work_authorization_present', 'REQUIRED', 'HARD_DENY', 'FLOOR'))),
        row(clientSubmittalPackageName('CLIENT', COMPANY_A), 'v1', def(req('work_authorization_present', 'NOT_REQUIRED', 'HARD_DENY', 'DEFAULT'))),
      ]),
    );
    await expect(svc.resolveEffective(TENANT, { company_id: COMPANY_A, requisition_id: null })).rejects.toMatchObject({
      code: 'CLIENT_SUBMITTAL_POLICY_INVALID',
      statusCode: 422,
    });
  });

  it('FLOOR — strengthening is allowed (OVERRIDABLE floor raised to HARD_DENY)', async () => {
    const svc = new ClientSubmittalPolicyService(
      new FakeGateway([
        row(pkgTenant, 'v1', def(req('rtr_present', 'REQUIRED', 'OVERRIDABLE', 'FLOOR'))),
        row(clientSubmittalPackageName('CLIENT', COMPANY_A), 'v1', def(req('rtr_present', 'REQUIRED', 'HARD_DENY', 'DEFAULT'))),
      ]),
    );
    const eff = await svc.resolveEffective(TENANT, { company_id: COMPANY_A, requisition_id: null });
    expect(eff!.requirements.find((r) => r.key === 'rtr_present')?.override_class).toBe('HARD_DENY');
  });

  it('effective-dating — resolves the version active at the instant', async () => {
    const svc = new ClientSubmittalPolicyService(
      new FakeGateway([
        row(pkgTenant, 'v1', def(req('resume_selected', 'REQUIRED', 'HARD_DENY')), new Date('2020-01-01T00:00:00Z'), new Date('2021-01-01T00:00:00Z')),
        row(pkgTenant, 'v2', def(req('resume_selected', 'REQUIRED', 'OVERRIDABLE')), new Date('2021-01-01T00:00:00Z'), null),
      ]),
    );
    const early = await svc.resolveEffective(TENANT, { company_id: null, requisition_id: null }, new Date('2020-06-01T00:00:00Z'));
    const late = await svc.resolveEffective(TENANT, { company_id: null, requisition_id: null }, new Date('2022-06-01T00:00:00Z'));
    expect(early!.requirements[0]?.override_class).toBe('HARD_DENY');
    expect(late!.requirements[0]?.override_class).toBe('OVERRIDABLE');
  });

  it('decide — OVERRIDABLE unsatisfied yields REQUIRES_OVERRIDE naming the override capability', async () => {
    const svc = new ClientSubmittalPolicyService(
      new FakeGateway([row(pkgTenant, 'v1', def(req('rtr_present', 'REQUIRED', 'OVERRIDABLE')))]),
    );
    const eff = await svc.resolveEffective(TENANT, { company_id: null, requisition_id: null });
    const decision = svc.decide(TENANT, eff!, { rtr_present: false }, 'c');
    expect(decision.decision).toBe('REQUIRES_OVERRIDE');
    expect(decision.required_capabilities).toContain(CLIENT_SUBMITTAL_OVERRIDE_CAPABILITY);
  });

  it('provenance — composite_version is deterministic from immutable layer identity + all layers captured', async () => {
    const rows = [
      row(pkgTenant, 'v1', def(req('resume_selected', 'REQUIRED', 'HARD_DENY'))),
      row(clientSubmittalPackageName('CLIENT', COMPANY_A), 'v3', def(req('work_authorization_present', 'REQUIRED', 'HARD_DENY'))),
    ];
    const a = await new ClientSubmittalPolicyService(new FakeGateway(rows)).resolveEffective(TENANT, { company_id: COMPANY_A, requisition_id: null });
    const b = await new ClientSubmittalPolicyService(new FakeGateway(rows)).resolveEffective(TENANT, { company_id: COMPANY_A, requisition_id: null });
    expect(a!.composite_version).toBe(b!.composite_version);
    expect(a!.layers.map((l) => ({ scope: l.scope, scope_ref: l.scope_ref, version: l.version }))).toEqual([
      { scope: 'TENANT', scope_ref: null, version: 'v1' },
      { scope: 'CLIENT', scope_ref: COMPANY_A, version: 'v3' },
    ]);
  });

  it('NOT_REQUIRED stays in the effective definition but emits no gating rule', async () => {
    const svc = new ClientSubmittalPolicyService(
      new FakeGateway([row(pkgTenant, 'v1', def(req('resume_selected', 'REQUIRED', 'HARD_DENY'), req('bill_rate_present', 'NOT_REQUIRED', 'HARD_DENY')))]),
    );
    const eff = await svc.resolveEffective(TENANT, { company_id: null, requisition_id: null });
    expect(eff!.requirements.map((r) => r.key).sort()).toEqual(['bill_rate_present', 'resume_selected']);
    // bill_rate false must NOT deny (NOT_REQUIRED emits no rule)
    expect(svc.decide(TENANT, eff!, { resume_selected: true, bill_rate_present: false }, 'c').decision).toBe('ALLOW');
  });
});

describe('read-side provenance / raw layers / history (PA-1)', () => {
  const tenantDef = def(
    req('resume_selected', 'REQUIRED', 'HARD_DENY', 'DEFAULT'),
    req('work_authorization_present', 'REQUIRED', 'HARD_DENY', 'FLOOR'),
  );
  const clientDef = def(
    req('resume_selected', 'REQUIRED', 'OVERRIDABLE', 'DEFAULT'), // override — changes override_class
    req('bill_rate_present', 'REQUIRED', 'HARD_DENY', 'DEFAULT'), // client-added
  );
  const pkgClientA = clientSubmittalPackageName('CLIENT', COMPANY_A);
  const svc = new ClientSubmittalPolicyService(
    new FakeGateway([row(pkgTenant, '1', tenantDef), row(pkgClientA, '1', clientDef)]),
  );

  it('resolveEffectiveView annotates each requirement with source layer + provenance', async () => {
    const view = await svc.resolveEffectiveView(TENANT, { company_id: COMPANY_A, requisition_id: null });
    expect(view).not.toBeNull();
    const byKey = Object.fromEntries(view!.requirements.map((r) => [r.key, r]));

    // Overridden at CLIENT (tenant had it, client changed override_class).
    expect(byKey['resume_selected'].source.scope).toBe('CLIENT');
    expect(byKey['resume_selected'].effective.override_class).toBe('OVERRIDABLE');
    expect(byKey['resume_selected'].provenance).toEqual({
      inherited: false, client_override: true, client_added: false, tenant_floor: false,
    });

    // Inherited TENANT FLOOR (never restated at client scope).
    expect(byKey['work_authorization_present'].source.scope).toBe('TENANT');
    expect(byKey['work_authorization_present'].provenance).toEqual({
      inherited: true, client_override: false, client_added: false, tenant_floor: true,
    });

    // Client-added (not present in tenant defaults).
    expect(byKey['bill_rate_present'].source.scope).toBe('CLIENT');
    expect(byKey['bill_rate_present'].provenance).toEqual({
      inherited: false, client_override: false, client_added: true, tenant_floor: false,
    });
  });

  it('resolveEffective (decision path) return shape is unchanged — raw merged requirements', async () => {
    const eff = await svc.resolveEffective(TENANT, { company_id: COMPANY_A, requisition_id: null });
    expect(eff!.requirements.map((r) => r.key).sort()).toEqual([
      'bill_rate_present', 'resume_selected', 'work_authorization_present',
    ]);
    expect(eff!.requirements.find((r) => r.key === 'resume_selected')!.override_class).toBe('OVERRIDABLE');
    // Same composite identity as the annotated view (single merge).
    const view = await svc.resolveEffectiveView(TENANT, { company_id: COMPANY_A, requisition_id: null });
    expect(eff!.composite_version).toBe(view!.composite_version);
  });

  it('readLayers returns each raw layer definition plus the merged effective', async () => {
    const layers = await svc.readLayers(TENANT, { company_id: COMPANY_A, requisition_id: null });
    expect(layers.tenant.present).toBe(true);
    expect(layers.tenant.requirements.map((r) => r.key).sort()).toEqual([
      'resume_selected', 'work_authorization_present',
    ]);
    expect(layers.client!.present).toBe(true);
    expect(layers.client!.requirements.map((r) => r.key).sort()).toEqual([
      'bill_rate_present', 'resume_selected',
    ]);
    expect(layers.requisition).toBeNull();
    expect(layers.effective!.requirements.length).toBe(3);
  });

  it('readLayers marks an absent client layer not-present (inherit-only)', async () => {
    const inheritOnly = new ClientSubmittalPolicyService(new FakeGateway([row(pkgTenant, '1', tenantDef)]));
    const layers = await inheritOnly.readLayers(TENANT, { company_id: COMPANY_B, requisition_id: null });
    expect(layers.client!.present).toBe(false);
    expect(layers.client!.requirements).toEqual([]);
    expect(layers.effective!.requirements.map((r) => r.key).sort()).toEqual([
      'resume_selected', 'work_authorization_present',
    ]);
  });

  it('history returns versions newest first with lifecycle status + immutable checksum', async () => {
    const v1 = row(pkgTenant, '1', tenantDef, new Date('2026-01-01T00:00:00Z'), new Date('2026-06-01T00:00:00Z'));
    const v2 = row(
      pkgTenant, '2', def(req('resume_selected', 'REQUIRED', 'HARD_DENY')),
      new Date('2026-06-01T00:00:00Z'), null,
    );
    const svcH = new ClientSubmittalPolicyService(new FakeGateway([v1, v2]));
    const hist = await svcH.history(TENANT, 'TENANT', null, new Date('2026-09-01T00:00:00Z'));
    expect(hist.map((h) => h.version)).toEqual(['2', '1']);
    expect(hist[0]!.status).toBe('current');
    expect(hist[0]!.effective_to).toBeNull();
    expect(hist[1]!.status).toBe('superseded');
    expect(hist[1]!.effective_to).toBe('2026-06-01T00:00:00.000Z');
    expect(hist[1]!.checksum).toBe(checksumDefinition(tenantDef));
  });
});
