import { beforeEach, describe, expect, it } from 'vitest';

import { VerificationCodeService, VerificationRefusedError, VerificationUnavailableError, VerificationService } from '../index.js';

import { VERIFIED, snapshot } from './support/fixtures.js';
import { ATS, codeOf, services, wrongCode } from './support/services.js';

// ATI-SEP-1 T4 — the talent email one-time code lifecycle over the in-memory
// unit of work: create → outbox fact (no code), expiry, attempt lock, confirm →
// TI-verified identifier + VERIFICATION_OUTCOME, bound-elsewhere contradiction,
// SMS path NOT_AVAILABLE, portal context, and re-resolution (R2) after binding.

const PORTAL = { client_id: 'portal', source_system_id: 'ARAMO_ATS' };
const T0 = new Date('2026-10-23T12:00:00.000Z');
const later = (ms: number) => new Date(T0.getTime() + ms);

function refOf(tenant: string, talent: string) {
  return { source_system_id: 'ARAMO_ATS' as const, source_tenant_id: tenant, external_talent_id: talent };
}

async function refusal(p: Promise<unknown>): Promise<VerificationRefusedError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof VerificationRefusedError) return err;
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('VerificationService — email one-time code', () => {
  let s: ReturnType<typeof services>;

  beforeEach(async () => {
    s = services();
    await s.ingest.ingest(
      snapshot({ tenant: 'tenant-a', talent: 'a-1', identity: { names: { first: 'Priya', last: 'Raman' }, emails: [{ value: 'priya@x.io', is_primary: true }] } }),
      ATS,
    );
  });

  const subjectOfRef = (tenant: string, talent: string) =>
    [...s.mem.state.references.values()].find((r) => r.source_tenant_id === tenant && r.external_talent_id === talent)?.subject_id as string;

  it('create → PENDING request (hash only), outbox fact with verification_id/channel/destination and NO code', async () => {
    const res = await s.verification.create({ source_reference: refOf('tenant-a', 'a-1'), identifier_type: 'EMAIL', value: ' Priya@X.io ' }, PORTAL, T0);
    expect(res).toMatchObject({ channel: 'EMAIL', status: 'PENDING', delivery: 'QUEUED', expires_at: later(600_000).toISOString() });
    const row = s.mem.state.verifications.get(res.verification_id);
    expect(row).toMatchObject({ status: 'PENDING', normalized_value: 'priya@x.io', attempts: 0, max_attempts: 5, subject_id: subjectOfRef('tenant-a', 'a-1') });
    expect(row?.code_hash).toMatch(/^[a-f0-9]{64}$/);
    const code = codeOf(s.mem, s.codes, res.verification_id);
    expect(row?.code_hash).toBe(VerificationCodeService.hash(row?.code_salt as string, code));
    const evt = s.mem.state.outbox.find((o) => o.event_type === 'identifier_verification.requested');
    expect(evt?.payload).toEqual({ verification_id: res.verification_id, channel: 'EMAIL', destination: 'priya@x.io' });
    expect(evt?.subject_type).toBe('verification_request');
    expect(JSON.stringify(evt)).not.toContain(`"${code}"`);
  });

  it('a newer request for the same identifier and subject expires the older one', async () => {
    const a = await s.verification.create({ source_reference: refOf('tenant-a', 'a-1'), identifier_type: 'EMAIL', value: 'priya@x.io' }, PORTAL, T0);
    const b = await s.verification.create({ source_reference: refOf('tenant-a', 'a-1'), identifier_type: 'EMAIL', value: 'priya@x.io' }, PORTAL, T0);
    expect(s.mem.state.verifications.get(a.verification_id)?.status).toBe('EXPIRED');
    expect(s.mem.state.verifications.get(b.verification_id)?.status).toBe('PENDING');
    expect((await refusal(s.verification.confirm(a.verification_id, { code: codeOf(s.mem, s.codes, a.verification_id) }, T0))).code).toBe('VERIFICATION_EXPIRED');
  });

  it('expires after 10 minutes', async () => {
    const r = await s.verification.create({ source_reference: refOf('tenant-a', 'a-1'), identifier_type: 'EMAIL', value: 'priya@x.io' }, PORTAL, T0);
    const code = codeOf(s.mem, s.codes, r.verification_id);
    const err = await refusal(s.verification.confirm(r.verification_id, { code }, later(600_001)));
    expect(err.code).toBe('VERIFICATION_EXPIRED');
    expect(s.mem.state.verifications.get(r.verification_id)?.status).toBe('EXPIRED');
  });

  it('5 wrong attempts LOCK the request; the right code then fails too', async () => {
    const r = await s.verification.create({ source_reference: refOf('tenant-a', 'a-1'), identifier_type: 'EMAIL', value: 'priya@x.io' }, PORTAL, T0);
    const code = codeOf(s.mem, s.codes, r.verification_id);
    for (let i = 1; i <= 4; i++) {
      const err = await refusal(s.verification.confirm(r.verification_id, { code: wrongCode(code) }, later(1000)));
      expect(err.code).toBe('INVALID_CODE');
      expect(err.details.attempts_remaining).toBe(5 - i);
    }
    const fifth = await refusal(s.verification.confirm(r.verification_id, { code: wrongCode(code) }, later(1000)));
    expect(fifth.code).toBe('VERIFICATION_LOCKED');
    expect(s.mem.state.verifications.get(r.verification_id)).toMatchObject({ status: 'LOCKED', attempts: 5 });
    expect((await refusal(s.verification.confirm(r.verification_id, { code }, later(2000)))).code).toBe('VERIFICATION_LOCKED');
  });

  it('confirm binds a TI-verified identifier, appends a VERIFICATION_OUTCOME, and refuses a second confirm', async () => {
    const r = await s.verification.create({ source_reference: refOf('tenant-a', 'a-1'), identifier_type: 'EMAIL', value: 'priya@x.io' }, PORTAL, T0);
    const out = await s.verification.confirm(r.verification_id, { code: codeOf(s.mem, s.codes, r.verification_id) }, later(1000));
    const subject = subjectOfRef('tenant-a', 'a-1');
    expect(out).toMatchObject({ outcome: 'BOUND', intelligence_subject_id: subject, merged_subject_ids: [] });
    const bound = [...s.mem.state.identifiers.values()].filter((i) => i.normalized_value === 'priya@x.io' && i.verification_status === 'VERIFIED');
    expect(bound).toHaveLength(1);
    expect(bound[0]).toMatchObject({
      subject_id: subject,
      verification_method: 'EMAIL_OTP',
      verification_source: 'aramo-portal',
      source_reference_id: null,
      verified_at: later(1000),
    });
    const outcome = [...s.mem.state.assertions.values()].find((a) => a.assertion_type === 'VERIFICATION_OUTCOME');
    expect(outcome).toMatchObject({ source_kind: 'VERIFICATION', verification_status: 'VERIFIED', source_tenant_id: null, source_reference_id: null });
    expect(outcome?.payload).toMatchObject({ target: 'EMAIL', result: 'CONFIRMED', method: 'EMAIL_OTP' });
    expect(JSON.stringify(outcome?.payload)).not.toContain('priya@x.io');
    expect(s.mem.state.verifications.get(r.verification_id)).toMatchObject({ status: 'CONFIRMED', outcome: 'BOUND' });
    // the projection now shows the contact as verified and the identity band raised
    expect(s.mem.state.trust.get(subject)?.identity_band).toBe('INDEPENDENTLY_VERIFIED');
    expect((await refusal(s.verification.confirm(r.verification_id, { code: '123456' }, later(2000)))).code).toBe('ALREADY_CONFIRMED');
  });

  it('an identifier already VERIFIED on another subject is never re-bound: ANCHOR_CONTRADICTION', async () => {
    await s.ingest.ingest(
      snapshot({ tenant: 'tenant-b', talent: 'b-1', identity: { names: { first: 'Anita', last: 'Kumar' }, emails: [{ value: 'shared@x.io', is_primary: true, verification: { ...VERIFIED } }] } }),
      ATS,
    );
    const other = subjectOfRef('tenant-b', 'b-1');
    const r = await s.verification.create({ source_reference: refOf('tenant-a', 'a-1'), identifier_type: 'EMAIL', value: 'shared@x.io' }, PORTAL, T0);
    const out = await s.verification.confirm(r.verification_id, { code: codeOf(s.mem, s.codes, r.verification_id) }, later(1000));
    expect(out.outcome).toBe('ANCHOR_CONTRADICTION');
    const verified = [...s.mem.state.identifiers.values()].filter((i) => i.normalized_value === 'shared@x.io' && i.verification_status === 'VERIFIED');
    expect(verified.map((i) => i.subject_id)).toEqual([other]);
    const conflicts = [...s.mem.state.conflicts.values()].filter((c) => c.subject_id === subjectOfRef('tenant-a', 'a-1'));
    expect(conflicts.map((c) => [c.conflict_type, c.related_subject_ids])).toEqual([['ANCHOR_CONTRADICTION', [other]]]);
    expect([...s.mem.state.assertions.values()].some((a) => a.assertion_type === 'VERIFICATION_OUTCOME')).toBe(false);
  });

  it('phone: the SMS path exists but the delivery adapter reports NOT_AVAILABLE', async () => {
    const r = await s.verification.create({ source_reference: refOf('tenant-a', 'a-1'), identifier_type: 'PHONE', value: '(555) 010-2000' }, PORTAL, T0);
    expect(r).toMatchObject({ channel: 'SMS', delivery: 'NOT_AVAILABLE' });
    expect(s.mem.state.verifications.get(r.verification_id)?.normalized_value).toBe('+15550102000');
  });

  it('portal context: binds to the one subject holding the value; ambiguous → UNBOUND', async () => {
    const r = await s.verification.create({ portal_context: { portal_session_id: 'sess-1' }, identifier_type: 'EMAIL', value: 'priya@x.io' }, PORTAL, T0);
    expect(s.mem.state.verifications.get(r.verification_id)?.portal_session_id).toBe('sess-1');
    expect((await s.verification.confirm(r.verification_id, { code: codeOf(s.mem, s.codes, r.verification_id) }, later(1000))).outcome).toBe('BOUND');

    await s.ingest.ingest(snapshot({ tenant: 'tenant-c', talent: 'c-1', identity: { emails: [{ value: 'dup@x.io', is_primary: true }] } }), ATS);
    await s.ingest.ingest(snapshot({ tenant: 'tenant-d', talent: 'd-1', identity: { emails: [{ value: 'dup@x.io', is_primary: true }] } }), ATS);
    const amb = await s.verification.create({ portal_context: { portal_session_id: 'sess-2' }, identifier_type: 'EMAIL', value: 'dup@x.io' }, PORTAL, T0);
    const out = await s.verification.confirm(amb.verification_id, { code: codeOf(s.mem, s.codes, amb.verification_id) }, later(1000));
    expect(out).toMatchObject({ outcome: 'UNBOUND', intelligence_subject_id: null });
    expect([...s.mem.state.identifiers.values()].some((i) => i.normalized_value === 'dup@x.io' && i.verification_status === 'VERIFIED')).toBe(false);
  });

  it('refuses an unknown / erased reference, a foreign source system and an invalid body', async () => {
    expect((await refusal(s.verification.create({ source_reference: refOf('tenant-a', 'nope'), identifier_type: 'EMAIL', value: 'p@x.io' }, PORTAL, T0))).code).toBe('REFERENCE_NOT_FOUND');
    expect((await refusal(s.verification.create({ identifier_type: 'EMAIL', value: 'p@x.io' }, PORTAL, T0))).code).toBe('INVALID_REQUEST');
    expect((await refusal(s.verification.create({ portal_context: { portal_session_id: 's' }, identifier_type: 'EMAIL', value: 'not-an-email' }, PORTAL, T0))).code).toBe('INVALID_REQUEST');
    expect((await refusal(s.verification.confirm('00000000-0000-4000-8000-000000000000', { code: '12345' }, T0))).code).toBe('INVALID_REQUEST');
    expect((await refusal(s.verification.confirm('00000000-0000-4000-8000-000000000000', { code: '123456' }, T0))).code).toBe('VERIFICATION_NOT_FOUND');
  });

  it('fails closed without INTELLIGENCE_VERIFICATION_CODE_KEY', async () => {
    const off = new VerificationService(s.mem, VerificationCodeService.fromEnv({}), s.delivery, s.mergeSplit, s.projection);
    await expect(off.create({ portal_context: { portal_session_id: 's' }, identifier_type: 'EMAIL', value: 'p@x.io' }, PORTAL, T0)).rejects.toBeInstanceOf(
      VerificationUnavailableError,
    );
  });

  it('re-resolution (R2): a newly verified anchor links another reference that vouched for it — the two references share one subject', async () => {
    // tenant-b holds the talent with another email first …
    await s.ingest.ingest(snapshot({ tenant: 'tenant-b', talent: 'b-1', identity: { names: { first: 'Priya', last: 'Raman' }, emails: [{ value: 'b-only@x.io', is_primary: true }] } }), ATS);
    // … tenant-a then binds priya.v@x.io (sender-verified) to its subject …
    await s.ingest.ingest(snapshot({ tenant: 'tenant-a', talent: 'a-1', identity: { emails: [{ value: 'priya.v@x.io', is_primary: true, verification: { ...VERIFIED } }] } }), ATS);
    // … tenant-b vouches for the same address as verified: R1 keeps it on its own subject, the binding is refused (contradiction) …
    await s.ingest.ingest(snapshot({ tenant: 'tenant-b', talent: 'b-1', identity: { emails: [{ value: 'priya.v@x.io', is_primary: true, verification: { ...VERIFIED } }] } }), ATS);
    // … and tenant-a stops vouching, releasing the binding.
    await s.ingest.ingest(snapshot({ tenant: 'tenant-a', talent: 'a-1', identity: { emails: [{ value: 'priya.v@x.io', is_primary: true }] } }), ATS);
    const a = subjectOfRef('tenant-a', 'a-1');
    const b = subjectOfRef('tenant-b', 'b-1');
    expect(a).not.toBe(b);

    // The talent proves control of the address.
    const r = await s.verification.create({ source_reference: refOf('tenant-a', 'a-1'), identifier_type: 'EMAIL', value: 'priya.v@x.io' }, PORTAL, T0);
    const out = await s.verification.confirm(r.verification_id, { code: codeOf(s.mem, s.codes, r.verification_id) }, later(1000));
    expect(out).toMatchObject({ outcome: 'BOUND', intelligence_subject_id: a, merged_subject_ids: [b] });
    expect(subjectOfRef('tenant-b', 'b-1')).toBe(a);
    expect(s.mem.state.subjects.get(b)).toMatchObject({ resolution_status: 'MERGED', merged_into_id: a });
    expect(s.mem.state.mergeSplit.at(-1)).toMatchObject({ kind: 'MERGE', from_subject_id: b, into_subject_id: a, actor: `verification:${r.verification_id}` });
  });

  it('re-resolution never links on an UNVERIFIED mention (R3: discovery only)', async () => {
    await s.ingest.ingest(snapshot({ tenant: 'tenant-b', talent: 'b-1', identity: { emails: [{ value: 'priya@x.io', is_primary: true }] } }), ATS);
    const r = await s.verification.create({ source_reference: refOf('tenant-a', 'a-1'), identifier_type: 'EMAIL', value: 'priya@x.io' }, PORTAL, T0);
    const out = await s.verification.confirm(r.verification_id, { code: codeOf(s.mem, s.codes, r.verification_id) }, later(1000));
    expect(out.merged_subject_ids).toEqual([]);
    expect(subjectOfRef('tenant-b', 'b-1')).not.toBe(subjectOfRef('tenant-a', 'a-1'));
  });
});
