import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EntitlementService, ReadRefusedError, SourceSystemMismatchError, TI_CROSS_TENANT_READ_ENABLED_ENV } from '../index.js';

import { VERIFIED, snapshot } from './support/fixtures.js';
import { ATS, codeOf, services } from './support/services.js';

// ATI-SEP-1 T6 (ADR-0036 §6, Addendum A1) — the read access-control matrix:
// unentitled 403, foreign source system 403, no reference 404, erased reference
// 404, audit-retained subject 404; TI_CROSS_TENANT_READ_ENABLED off → only the
// requesting tenant's assertions (+ TI verification), on → the full Golden
// projection; other tenants are never named; artifacts by policy; every read audited.

const A = { source_system_id: 'ARAMO_ATS', source_tenant_id: 'tenant-a', external_talent_id: 'a-1' };
const B = { source_system_id: 'ARAMO_ATS', source_tenant_id: 'tenant-b', external_talent_id: 'b-1' };
const READER = { client_id: 'ats-reader', source_system_id: 'ARAMO_ATS' };

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ReadRefusedError) return err.code;
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('ProfileReadService — access control matrix', () => {
  let s: ReturnType<typeof services>;
  let saved: string | undefined;
  const setCross = (on: boolean) => {
    process.env[TI_CROSS_TENANT_READ_ENABLED_ENV] = on ? 'true' : 'false';
  };

  beforeEach(async () => {
    saved = process.env[TI_CROSS_TENANT_READ_ENABLED_ENV];
    delete process.env[TI_CROSS_TENANT_READ_ENABLED_ENV];
    s = services();
    const email = (extra: Array<{ value: string; is_primary: boolean }> = []) => [{ value: 'priya@x.io', is_primary: true, verification: { ...VERIFIED } }, ...extra];
    await s.ingest.ingest(
      snapshot({
        tenant: 'tenant-a',
        talent: 'a-1',
        identity: { names: { first: 'Priya', last: 'Raman' }, emails: email() },
        assertions: [
          { assertion_type: 'SKILL', payload: { name: 'TypeScript' }, source_kind: 'RECRUITER', observed_at: '2026-10-01T00:00:00.000Z' },
          { assertion_type: 'TITLE', payload: { value: 'Engineer' }, source_kind: 'RECRUITER', observed_at: '2026-10-01T00:00:00.000Z' },
        ],
      }),
      ATS,
    );
    await s.ingest.ingest(
      snapshot({
        tenant: 'tenant-b',
        talent: 'b-1',
        identity: { names: { first: 'Priya', last: 'Raman' }, emails: email([{ value: 'priya.b-only@x.io', is_primary: false }]) },
        assertions: [
          { assertion_type: 'SKILL', payload: { name: 'Go' }, source_kind: 'RECRUITER', observed_at: '2026-10-05T00:00:00.000Z' },
          { assertion_type: 'TITLE', payload: { value: 'Manager' }, source_kind: 'RECRUITER', observed_at: '2026-10-05T00:00:00.000Z' },
        ],
      }),
      ATS,
    );
    await new EntitlementService(s.mem).sync({ source_system_id: 'ARAMO_ATS', mode: 'UPSERT', tenants: [{ tenant_id: 'tenant-a', active: true }, { tenant_id: 'tenant-b', active: true }] }, ATS);
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[TI_CROSS_TENANT_READ_ENABLED_ENV];
    else process.env[TI_CROSS_TENANT_READ_ENABLED_ENV] = saved;
  });

  const audits = () => s.mem.state.readAudit;

  it('the two tenants resolved to ONE subject (verified email, R2)', () => {
    const refs = [...s.mem.state.references.values()];
    expect(new Set(refs.map((r) => r.subject_id)).size).toBe(1);
  });

  it('unentitled → NOT_ENTITLED (403 class), also when the entitlement was deactivated; audited', async () => {
    await new EntitlementService(s.mem).sync({ source_system_id: 'ARAMO_ATS', mode: 'REPLACE', tenants: [{ tenant_id: 'tenant-b', active: true }] }, ATS);
    expect(s.mem.state.entitlements.get('ARAMO_ATS|tenant-a')?.active).toBe(false);
    expect(await refusal(s.reads.profile(READER, A))).toBe('NOT_ENTITLED');
    expect(await refusal(s.reads.evidence(READER, { ...A, source_tenant_id: 'tenant-zz' }))).toBe('NOT_ENTITLED');
    expect(audits().map((r) => [r.read_kind, r.outcome, r.fields_returned])).toEqual([
      ['PROFILE', 'NOT_ENTITLED', 0],
      ['EVIDENCE', 'NOT_ENTITLED', 0],
    ]);
  });

  it('a principal of another source system → SOURCE_SYSTEM_MISMATCH', async () => {
    expect(await refusal(s.reads.profile({ client_id: 'x', source_system_id: 'OTHER' }, A))).toBe('SOURCE_SYSTEM_MISMATCH');
    await expect(new EntitlementService(s.mem).sync({ source_system_id: 'ARAMO_ATS', mode: 'UPSERT', tenants: [] }, { client_id: 'x', source_system_id: 'OTHER' })).rejects.toBeInstanceOf(
      SourceSystemMismatchError,
    );
  });

  it('no reference → 404; erased reference → 404; audit-retained subject → 404', async () => {
    expect(await refusal(s.reads.profile(READER, { ...A, external_talent_id: 'nope' }))).toBe('REFERENCE_NOT_FOUND');
    await s.ingest.erase({ ...A, source_event_id: 'erase-a', occurred_at: '2026-10-23T00:00:00.000Z' }, ATS);
    expect(await refusal(s.reads.profile(READER, A))).toBe('REFERENCE_NOT_FOUND');
    expect((await s.reads.profile(READER, B)).facts.length).toBeGreaterThan(0);
    const subject = [...s.mem.state.subjects.values()][0] as NonNullable<ReturnType<typeof s.mem.state.subjects.get>>;
    s.mem.state.subjects.set(subject.id, { ...subject, access_state: 'AUDIT_RETAINED' });
    expect(await refusal(s.reads.profile(READER, B))).toBe('REFERENCE_NOT_FOUND');
    expect(audits().map((r) => r.outcome)).toEqual(['REFERENCE_NOT_FOUND', 'REFERENCE_NOT_FOUND', 'GRANTED', 'REFERENCE_NOT_FOUND']);
  });

  it('flag OFF (default): only tenant-a facts + TI verification; no other tenant data, no hidden contradiction', async () => {
    const r = await s.verification.create({ source_reference: { ...A, source_system_id: 'ARAMO_ATS' }, identifier_type: 'EMAIL', value: 'priya@x.io' }, ATS);
    await s.verification.confirm(r.verification_id, { code: codeOf(s.mem, s.codes, r.verification_id) });

    const p = await s.reads.profile(READER, A);
    expect(p.access_mode).toBe('TENANT_SCOPED');
    expect(p.facts.filter((f) => f.fact_type === 'SKILL').map((f) => f.fact_key)).toEqual(['typescript']);
    expect(p.facts.find((f) => f.fact_type === 'TITLE')).toMatchObject({ value: { value: 'Engineer' }, state: 'RESOLVED' });
    expect(p.facts.filter((f) => f.fact_type === 'EMAIL').map((f) => f.fact_key)).toEqual(['priya@x.io']);
    expect(p.trust.open_contradiction_count).toBe(0);

    const e = await s.reads.evidence(READER, A);
    expect(new Set(e.assertions.map((x) => x.contributed_by))).toEqual(new Set(['REQUESTING_TENANT', 'TALENT_INTELLIGENCE']));
    expect(e.assertions.find((x) => x.assertion_type === 'TITLE' && x.contributed_by === 'REQUESTING_TENANT')?.status).toBe('VALID');
    expect(e.assertions.some((x) => x.assertion_type === 'VERIFICATION_OUTCOME')).toBe(true);
    const json = JSON.stringify([p, e]);
    for (const leak of ['tenant-b', 'b-1', 'Manager', 'priya.b-only@x.io', '"Go"']) expect(json).not.toContain(leak);
  });

  it('flag ON: the full Golden projection; other sources are named only as OTHER_SOURCE', async () => {
    setCross(true);
    const p = await s.reads.profile(READER, A);
    expect(p.access_mode).toBe('CROSS_TENANT');
    expect(p.facts.filter((f) => f.fact_type === 'SKILL').map((f) => f.fact_key)).toEqual(['go', 'typescript']);
    expect(p.facts.filter((f) => f.fact_type === 'EMAIL').map((f) => f.fact_key).sort()).toEqual(['priya.b-only@x.io', 'priya@x.io']);
    expect(p.facts.find((f) => f.fact_type === 'TITLE')?.state).toBe('CONTRADICTED');
    const e = await s.reads.evidence(READER, A);
    expect(e.assertions.some((x) => x.contributed_by === 'OTHER_SOURCE')).toBe(true);
    expect(e.assertions.find((x) => x.assertion_type === 'TITLE' && x.contributed_by === 'REQUESTING_TENANT')?.status).toBe('CONTRADICTED');
    expect(JSON.stringify(e)).not.toContain('tenant-b');
    expect(audits().map((r) => [r.outcome, r.access_mode])).toEqual([
      ['GRANTED', 'CROSS_TENANT'],
      ['GRANTED', 'CROSS_TENANT'],
    ]);
    expect(audits()[0]?.fields_returned).toBe(p.facts.length);
  });

  it('artifacts: only globally shareable document types, metadata only', async () => {
    const subjectId = [...s.mem.state.subjects.keys()][0] as string;
    await s.mem.run(async (r) => {
      await r.artifacts.upsertPolicy('CERTIFICATE', true);
      await r.artifacts.upsertPolicy('ID_SCAN', false);
      await r.artifacts.create({ subject_id: subjectId, document_type: 'CERTIFICATE', storage_key: 'ti/k1', sha256: 'a'.repeat(64), retrieved_at: new Date('2026-10-01T00:00:00.000Z') });
      await r.artifacts.create({ subject_id: subjectId, document_type: 'ID_SCAN', storage_key: 'ti/k2', sha256: 'b'.repeat(64), retrieved_at: new Date('2026-10-01T00:00:00.000Z') });
    });
    const res = await s.reads.artifacts(READER, A);
    expect(res.artifacts.map((x) => x.document_type)).toEqual(['CERTIFICATE']);
    expect(JSON.stringify(res)).not.toContain('ti/k1');
    expect(audits().at(-1)).toMatchObject({ read_kind: 'ARTIFACTS', outcome: 'GRANTED', fields_returned: 1 });
  });
});
