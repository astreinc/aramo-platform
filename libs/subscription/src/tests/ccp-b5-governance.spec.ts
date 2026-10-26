import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildAuditCsv, csvField } from '../lib/commercial/commercial-audit-export.service.js';
import type { CommercialAuditEventRow } from '../lib/commercial/commercial-audit.repository.js';
import type { RosterEntry } from '../lib/commercial/commercial-approval-eligibility.js';
import { CommercialPayloadError, validatePayload } from '../lib/commercial/commercial-change-request.js';
import { chainFulfillability } from '../lib/commercial/commercial-operator-roster.service.js';
import { POLICY_EDIT_RANGES, policyRangeErrors } from '../lib/commercial/commercial-policy-governance.service.js';
import { parseCommercialPolicyContent } from '../lib/commercial/commercial-policy.js';

// CCP-B5 — the pure parts: the POLICY_ACTIVATE payload (snapshot key), the audit CSV, the
// policy edit ranges and the chain-fulfillability panel. Test IDs are cited by
// doc/ccp/slices/CCP-B5-acceptance.md.

const REPO = resolve(__dirname, '../../../..');
const V1 = (() => {
  const sql = readFileSync(resolve(REPO, 'libs/subscription/prisma/migrations/20261024180000_ccp_a2_commercial_audit_policy/migration.sql'), 'utf8');
  const m = /'(\{"approval_expiry_hours"[^']+\})'/.exec(sql);
  if (m === null || m[1] === undefined) throw new Error('v1 policy literal not found');
  return parseCommercialPolicyContent(JSON.parse(m[1]));
})();
const UUID = '019a0000-0000-7000-8000-0000000cc2a2';

describe('CCP-B5 POLICY_ACTIVATE payload (pre-execution C-3)', () => {
  it('B5-U-1 accepts the target id with or without the content snapshot; refuses any other key and a malformed snapshot', () => {
    expect(validatePayload('POLICY_ACTIVATE', { policy_version_id: UUID })).toEqual({ policy_version_id: UUID });
    expect(validatePayload('POLICY_ACTIVATE', { policy_version_id: UUID, target_content_checksum: 'a'.repeat(64) })).toEqual({ policy_version_id: UUID, target_content_checksum: 'a'.repeat(64) });
    expect(() => validatePayload('POLICY_ACTIVATE', { policy_version_id: UUID, note: 'x' })).toThrow(CommercialPayloadError);
    expect(() => validatePayload('POLICY_ACTIVATE', { policy_version_id: UUID, target_content_checksum: 'A'.repeat(64) })).toThrow(CommercialPayloadError);
    expect(() => validatePayload('POLICY_ACTIVATE', { policy_version_id: UUID, target_content_checksum: 'abc' })).toThrow(CommercialPayloadError);
  });
});

describe('CCP-B5 audit CSV (handoff §5.7)', () => {
  const row = (o: Partial<CommercialAuditEventRow>): CommercialAuditEventRow => ({
    id: '019a0000-0000-7000-8000-00000000e001',
    actor_id: '019a0000-0000-7000-8000-00000000a001',
    actor_type: 'user',
    actor_role_keys: ['finance_admin', 'platform_owner'],
    event_type: 'COMMERCIAL_APPROVAL_RECORDED',
    is_exception: false,
    tenant_id: '019a0000-0000-7000-8000-00000000b001',
    subject: 'commercial_change_request:x',
    change_request_id: '019a0000-0000-7000-8000-00000000c001',
    policy_version_id: '019a0000-0000-7000-8000-0000000cc201',
    payload: { product_key: 'sign', step_index: 0 },
    correlation_id: 'c',
    created_at: new Date('2026-10-24T14:00:00.000Z'),
    ...o,
  });

  it('B5-U-2 the header is the design column list; each event is one quoted CRLF line with codes, role keys and the canonical payload JSON', () => {
    const csv = buildAuditCsv([row({}), row({ id: '019a0000-0000-7000-8000-00000000e002', actor_id: null, actor_type: 'system', actor_role_keys: [], tenant_id: null, change_request_id: null, is_exception: true, payload: { b: 2, a: 'say "hi"' } })], {
      actors: new Map([['019a0000-0000-7000-8000-00000000a001', 'Arjun Rao']]),
      tenants: new Map([['019a0000-0000-7000-8000-00000000b001', 'Halcyon Health']]),
    });
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('id,time_utc,event,actor,roles,tenant,product,change_request,exception,detail');
    expect(lines[1]).toBe(
      '"019a0000-0000-7000-8000-00000000e001","2026-10-24T14:00:00.000Z","COMMERCIAL_APPROVAL_RECORDED","Arjun Rao","finance_admin platform_owner","Halcyon Health","sign","019a0000-0000-7000-8000-00000000c001","","{""product_key"":""sign"",""step_index"":0}"',
    );
    expect(lines[2]).toBe('"019a0000-0000-7000-8000-00000000e002","2026-10-24T14:00:00.000Z","COMMERCIAL_APPROVAL_RECORDED","system","","","","","yes","{""a"":""say \\""hi\\"""",""b"":2}"');
    expect(lines[3]).toBe('');
    expect(lines).toHaveLength(4);
  });

  it('B5-U-3 a field a spreadsheet would evaluate is neutralised (formula injection); quotes are doubled', () => {
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    for (const lead of ['+', '-', '@', '\t', '\r']) expect(csvField(`${lead}1`).startsWith(`"'${lead}`)).toBe(true);
    expect(csvField('plain')).toBe('"plain"');
    expect(csvField(null)).toBe('""');
  });
});

describe('CCP-B5 policy edit ranges (handoff §5.6)', () => {
  it('B5-U-4 the v1 document is inside every range; each bound is inclusive and one unit outside is refused', () => {
    expect(policyRangeErrors(V1 as unknown as Record<string, unknown>)).toEqual([]);
    for (const [k, [min, max]] of Object.entries(POLICY_EDIT_RANGES) as Array<[string, readonly [number, number]]>) {
      expect(policyRangeErrors({ [k]: min }), `${k} min`).toEqual([]);
      expect(policyRangeErrors({ [k]: max }), `${k} max`).toEqual([]);
      expect(policyRangeErrors({ [k]: min - 1 }), `${k} below`).toHaveLength(1);
      expect(policyRangeErrors({ [k]: max + 1 }), `${k} above`).toHaveLength(1);
    }
    // Handoff §5.6 ranges, in document units: 0–100 %, $0–$100,000, 1–60 d, 30–365 d, 1–120 d, 12–168 h, 0–30 d.
    expect(POLICY_EDIT_RANGES).toEqual({
      discount_escalation_threshold_bps: [0, 10_000],
      credit_escalation_threshold_minor: [0, 10_000_000],
      support_extension_max_days: [1, 60],
      support_extension_frequency_window_days: [30, 365],
      support_extension_cumulative_max_days: [1, 120],
      approval_expiry_hours: [12, 168],
      past_due_grace_days: [0, 30],
    });
  });
});

describe('CCP-B5 chain fulfillability (handoff §3.2; the A3 gate, per chain)', () => {
  const OWNER = ['platform:catalog:approve', 'platform:catalog:publish', 'platform:subscription:approve', 'platform:entitlement:approve', 'platform:billing:approve'];
  const FIN = ['platform:catalog:approve', 'platform:subscription:approve', 'platform:entitlement:approve', 'platform:billing:approve'];
  const r = (user_id: string, roles: string[], scopes: string[], attested = true): RosterEntry => ({ user_id, role_keys: roles, scopes, attested });
  const ready = [
    r('owner', ['platform_owner'], OWNER),
    r('owner2', ['platform_owner'], OWNER),
    r('fin', ['finance_admin'], FIN),
    r('fin2', ['finance_admin'], FIN),
    r('ops', ['commercial_ops'], ['platform:subscription:request', 'platform:entitlement:request', 'platform:billing:request']),
    r('cat', ['catalog_manager'], ['platform:catalog:draft']),
  ];
  const keyed = (roster: RosterEntry[]) => Object.fromEntries(chainFulfillability(roster, V1).map((c) => [c.key, c.fulfillable ? 'ok' : c.missing]));

  it('B5-U-5 a full roster fulfils all five chains', () => {
    expect(keyed(ready)).toEqual({ ABOVE_THRESHOLD: 'ok', BELOW_THRESHOLD: 'ok', CATALOG_PUBLISH: 'ok', ROLE_CHANGE: 'ok', POLICY_CHANGE: 'ok' });
  });

  it('B5-U-6 one person holding finance_admin and platform_owner fills at most one step (NC-2); an unattested holder never counts (NOT_HUMAN); a missing maker is named', () => {
    const arjun = [r('arjun', ['finance_admin', 'platform_owner'], OWNER), r('ops', ['commercial_ops'], ['platform:billing:request', 'platform:subscription:request'])];
    expect(keyed(arjun)).toMatchObject({ ABOVE_THRESHOLD: 'steps', BELOW_THRESHOLD: 'ok', CATALOG_PUBLISH: 'maker', ROLE_CHANGE: 'steps', POLICY_CHANGE: 'steps' });
    const unattested = ready.map((e) => (e.user_id === 'owner2' ? { ...e, attested: false } : e));
    expect(keyed(unattested).ROLE_CHANGE).toBe('steps');
    // A governance maker must be attested too (TD-A3-5): an unattested sole finance maker cannot make a policy request.
    const noFinanceMaker = ready.map((e) => (e.role_keys.includes('finance_admin') ? { ...e, attested: false } : e));
    expect(keyed(noFinanceMaker).POLICY_CHANGE).toBe('maker');
  });

  it('B5-U-7 the steps are the real chains: role change = one distinct owner; policy = finance → owner (Q1); catalog = finance → owner', () => {
    const c = Object.fromEntries(chainFulfillability(ready, V1).map((x) => [x.key, x]));
    expect(c['ROLE_CHANGE']).toMatchObject({ rule: 'DISTINCT_PLATFORM_OWNER', step_roles: ['platform_owner'], maker_roles: ['platform_owner'] });
    expect(c['POLICY_CHANGE']).toMatchObject({ rule: 'FINANCE_THEN_OWNER', step_roles: ['finance_admin', 'platform_owner'], maker_roles: ['finance_admin'] });
    expect(c['CATALOG_PUBLISH']).toMatchObject({ rule: 'FINANCE_THEN_OWNER', maker_roles: ['catalog_manager'] });
    expect(c['ABOVE_THRESHOLD']).toMatchObject({ rule: 'FINANCE_THEN_OWNER', maker_roles: ['commercial_ops'] });
    expect(c['BELOW_THRESHOLD']).toMatchObject({ rule: 'FINANCE_ONLY', maker_roles: ['commercial_ops', 'support_admin'] });
  });
});

describe('CCP-B5 no grant path outside the governed request (PBD §5.3 B5 "Out: any direct role grant")', () => {
  const B5_SOURCES = [
    'libs/subscription/src/lib/commercial/commercial-policy-activation.ts',
    'libs/subscription/src/lib/commercial/commercial-policy-apply.service.ts',
    'libs/subscription/src/lib/commercial/commercial-policy-governance.service.ts',
    'libs/subscription/src/lib/commercial/commercial-audit-export.service.ts',
    'libs/subscription/src/lib/commercial/commercial-operator-roster.service.ts',
    'apps/platform-admin/src/app/platform/platform-commercial-governance.controller.ts',
  ];
  const WRITES = /grantPlatformRole|revokePlatformRole|INSERT INTO identity|DELETE FROM identity|UPDATE identity|commercialOperatorAttestation\.(create|update)/;

  it('B5-U-8 no B5 source writes an identity row, a role or an attestation; the identity role writers are called only by the governed apply and the one-time bootstrap', () => {
    for (const f of B5_SOURCES) expect(WRITES.test(readFileSync(resolve(REPO, f), 'utf8')), f).toBe(false);
    const svc = readFileSync(resolve(REPO, 'libs/subscription/src/lib/commercial/commercial-change-request.service.ts'), 'utf8');
    // In the change-request service the writers appear only inside applyRoleChange (the A9 governed apply).
    const body = svc.slice(svc.indexOf('async applyRoleChange('), svc.indexOf('/** CCP-B5: fills the NC-5 target snapshot'));
    expect(body).toContain('grantPlatformRole(');
    expect(body).toContain('revokePlatformRole(');
    const rest = svc.replace(body, '');
    expect(/grantPlatformRole\(|revokePlatformRole\(/.test(rest.replace(/^import[\s\S]*?from '.\/commercial-role-change.js';/m, ''))).toBe(false);
  });
});
