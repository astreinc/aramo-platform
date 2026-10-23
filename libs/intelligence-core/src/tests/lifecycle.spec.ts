import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LifecycleRefusedError, TI_CROSS_TENANT_READ_ENABLED_ENV, type Assertion } from '../index.js';

import { VERIFIED, snapshot } from './support/fixtures.js';
import { ATS, codeOf, services } from './support/services.js';

// ATI-SEP-1 T10 (Addendum A3 T10-2) — the evidence lifecycle on the in-memory
// unit of work: the dispute state machine + SLA extension, respond / withdraw,
// proposal generation / dismiss / act / settle, contradiction resolution (link +
// event + projection) and the tenant access matrix.
//
// Fixture: one subject (the shared sender-verified email) held by
//   tenant-a / a-1  TITLE Engineer (10-01), SKILL TypeScript, phone (unverified)
//   tenant-a / a-2  TITLE Manager  (10-05)          → a contradiction inside tenant A's view
//   tenant-b / b-1  TITLE Director (10-03), SKILL Go → visible to A only with the cross-tenant flag
// Entitled: tenant-a, tenant-b, tenant-c (holds no reference). tenant-d is not entitled.

const A1 = { source_system_id: 'ARAMO_ATS', source_tenant_id: 'tenant-a', external_talent_id: 'a-1' } as const;
const A2 = { source_system_id: 'ARAMO_ATS', source_tenant_id: 'tenant-a', external_talent_id: 'a-2' } as const;
const B1 = { source_system_id: 'ARAMO_ATS', source_tenant_id: 'tenant-b', external_talent_id: 'b-1' } as const;
const NOW = new Date('2026-10-23T12:00:00.000Z');
const DAY = 86_400_000;

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof LifecycleRefusedError) return err.code;
    throw err;
  }
  throw new Error('expected a refusal');
}

const email = [{ value: 'priya@x.io', is_primary: true, verification: { ...VERIFIED } }];
const title = (value: string, at: string) => ({ assertion_type: 'TITLE' as const, payload: { value }, source_kind: 'RECRUITER' as const, observed_at: at });
const skill = (name: string) => ({ assertion_type: 'SKILL' as const, payload: { name }, source_kind: 'RECRUITER' as const, observed_at: '2026-10-01T00:00:00.000Z' });

const a1Snapshot = () =>
  snapshot({
    tenant: 'tenant-a',
    talent: 'a-1',
    identity: { names: { first: 'Priya', last: 'Raman' }, emails: email, phones: [{ value: '+1 555 010 2000', is_primary: true }] },
    assertions: [title('Engineer', '2026-10-01T00:00:00.000Z'), skill('TypeScript')],
  });

describe('ATI-SEP-1 T10 — evidence lifecycle', () => {
  let s: ReturnType<typeof services>;
  let saved: string | undefined;
  const setCross = (on: boolean) => {
    process.env[TI_CROSS_TENANT_READ_ENABLED_ENV] = on ? 'true' : 'false';
  };
  const find = (tenant: string, type: string, value?: string): Assertion => {
    const hit = [...s.mem.state.assertions.values()].find(
      (a) =>
        a.source_tenant_id === tenant &&
        a.assertion_type === type &&
        (value === undefined || JSON.stringify(a.payload).includes(value)) &&
        !['SUPERSEDED', 'WITHDRAWN'].includes(a.current_status),
    );
    if (!hit) throw new Error(`no ${type} ${value ?? ''} for ${tenant}`);
    return s.mem.state.assertions.get(hit.id) as Assertion;
  };
  const subjectId = () => find('tenant-a', 'TITLE', 'Engineer').subject_id;
  const status = (id: string) => s.mem.state.assertions.get(id)?.current_status;
  const events = (id: string) => s.mem.state.events.filter((e) => e.assertion_id === id).map((e) => e.event_type);
  const open = (assertionId: string, ctx: typeof A1 | typeof B1 = A1, statement = 'This title is wrong.') =>
    s.disputes.open({ portal_context: ctx, assertion_id: assertionId, statement }, ATS, NOW);
  const act = (tenant: string, extra: Record<string, unknown> = {}) => ({ source_tenant_id: tenant, actor: 'user-1', ...extra });

  beforeEach(async () => {
    saved = process.env[TI_CROSS_TENANT_READ_ENABLED_ENV];
    delete process.env[TI_CROSS_TENANT_READ_ENABLED_ENV];
    s = services();
    await s.mem.run(async (r) => {
      for (const t of ['tenant-a', 'tenant-b', 'tenant-c']) await r.entitlements.upsert('ARAMO_ATS', t, true);
    });
    await s.ingest.ingest(a1Snapshot(), ATS);
    await s.ingest.ingest(
      snapshot({ tenant: 'tenant-a', talent: 'a-2', identity: { names: { first: 'Priya', last: 'Raman' }, emails: email }, assertions: [title('Manager', '2026-10-05T00:00:00.000Z')] }),
      ATS,
    );
    await s.ingest.ingest(
      snapshot({
        tenant: 'tenant-b',
        talent: 'b-1',
        identity: { names: { first: 'Priya', last: 'Raman' }, emails: email },
        assertions: [title('Director', '2026-10-03T00:00:00.000Z'), skill('Go')],
      }),
      ATS,
    );
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[TI_CROSS_TENANT_READ_ENABLED_ENV];
    else process.env[TI_CROSS_TENANT_READ_ENABLED_ENV] = saved;
  });

  it('fixture: one subject; titles CONTRADICTED; has_open_dispute false', () => {
    expect(new Set([...s.mem.state.assertions.values()].map((a) => a.subject_id)).size).toBe(1);
    expect(status(find('tenant-a', 'TITLE', 'Engineer').id)).toBe('CONTRADICTED');
    expect(s.mem.state.trust.get(subjectId())?.has_open_dispute).toBe(false);
  });

  // ── dispute state machine ──────────────────────────────────────────────────

  describe('disputes — portal open', () => {
    it('opens OPEN with the SLA clocks, the statement and an OPENED event; the assertion does not move yet', async () => {
      const skillA = find('tenant-a', 'SKILL', 'TypeScript');
      const d = await open(skillA.id);
      expect(d.status).toBe('OPEN');
      expect(d.statements).toEqual([{ author: 'TALENT', statement: 'This title is wrong.', created_at: expect.any(String) }]);
      expect(Date.parse(d.sla.triage_due_at) - NOW.getTime()).toBe(3 * DAY);
      expect(Date.parse(d.sla.summary_due_at) - NOW.getTime()).toBe(5 * DAY);
      expect(Date.parse(d.sla.reinvestigation_due_at) - NOW.getTime()).toBe(30 * DAY);
      expect(Date.parse(d.sla.ccpa_due_at as string) - NOW.getTime()).toBe(45 * DAY);
      expect(d.sla.reinvestigation_extended_at).toBeNull();
      expect(status(skillA.id)).toBe('VALID');
      expect(s.mem.state.disputeEvents.map((e) => e.event_type)).toEqual(['OPENED']);
    });

    it('one open dispute per assertion: a second open returns the same dispute (no second statement)', async () => {
      const skillA = find('tenant-a', 'SKILL', 'TypeScript');
      const first = await open(skillA.id);
      const again = await open(skillA.id, A1, 'again');
      expect(again.dispute_id).toBe(first.dispute_id);
      expect(s.mem.state.disputeStatements).toHaveLength(1);
    });

    it('refuses: invalid body 400, foreign source system 403, unknown reference 404, assertion of another subject 404, retired assertion 422', async () => {
      const skillA = find('tenant-a', 'SKILL', 'TypeScript');
      expect(await code(s.disputes.open({ portal_context: A1, assertion_id: skillA.id }, ATS))).toBe('INVALID_REQUEST');
      expect(await code(s.disputes.open({ portal_context: A1, assertion_id: skillA.id, statement: 'x', extra: 1 }, ATS))).toBe('INVALID_REQUEST');
      expect(await code(s.disputes.open({ portal_context: A1, assertion_id: skillA.id, statement: 'x' }, { client_id: 'o', source_system_id: 'OTHER' }))).toBe('SOURCE_SYSTEM_MISMATCH');
      expect(await code(open(skillA.id, { ...A1, external_talent_id: 'nope' } as typeof A1))).toBe('REFERENCE_NOT_FOUND');
      await s.ingest.ingest(snapshot({ tenant: 'tenant-z', talent: 'z-1', identity: { names: { first: 'Zed', last: 'Other' } }, assertions: [skill('Rust')] }), ATS);
      expect(await code(open(find('tenant-z', 'SKILL', 'Rust').id))).toBe('NOT_FOUND');
      await s.ingest.ingest({ ...a1Snapshot(), assertions: [title('Engineer', '2026-10-01T00:00:00.000Z')] }, ATS); // TypeScript superseded
      expect(await code(open(skillA.id))).toBe('ASSERTION_NOT_DISPUTABLE');
    });
  });

  describe('disputes — tenant disposition', () => {
    it('triage: OPEN → UNDER_REVIEW, assertion → DISPUTED (event), projection has_open_dispute; re-triage is a no-op', async () => {
      const skillA = find('tenant-a', 'SKILL', 'TypeScript');
      const d = await open(skillA.id);
      expect(await s.disputes.triage(d.dispute_id, act('tenant-a'), ATS, NOW)).toEqual({ dispute_id: d.dispute_id, status: 'UNDER_REVIEW' });
      expect(status(skillA.id)).toBe('DISPUTED');
      expect(events(skillA.id)).toContain('DISPUTED');
      expect(s.mem.state.events.find((e) => e.event_type === 'DISPUTED')?.actor).toBe('tenant:ARAMO_ATS:tenant-a:user-1');
      expect(s.mem.state.trust.get(subjectId())?.has_open_dispute).toBe(true);
      expect((await s.disputes.triage(d.dispute_id, act('tenant-a'), ATS, NOW)).status).toBe('UNDER_REVIEW');
      expect(await code(s.disputes.triage(d.dispute_id, act('tenant-a', { note: 'n' }), ATS))).toBe('INVALID_REQUEST');
    });

    it('correct: only after triage (422 before); DISPUTED → REVOKED (CORRECTED); the corrected claim is not re-admitted by the same reference', async () => {
      const skillA = find('tenant-a', 'SKILL', 'TypeScript');
      const d = await open(skillA.id);
      expect(await code(s.disputes.correct(d.dispute_id, act('tenant-a', { note: 'fixed' }), ATS))).toBe('DISPUTE_NOT_UNDER_REVIEW');
      await s.disputes.triage(d.dispute_id, act('tenant-a'), ATS, NOW);
      expect(await code(s.disputes.correct(d.dispute_id, act('tenant-a'), ATS))).toBe('INVALID_REQUEST'); // note required
      expect((await s.disputes.correct(d.dispute_id, act('tenant-a', { note: 'The skill was recorded in error.' }), ATS, NOW)).status).toBe('RESOLVED_CORRECTED');
      expect(status(skillA.id)).toBe('REVOKED');
      expect(events(skillA.id).slice(-1)).toEqual(['CORRECTED']);
      expect(s.mem.state.trust.get(subjectId())?.has_open_dispute).toBe(false);
      const portal = await s.disputes.getForPortal(d.dispute_id, 'ARAMO_ATS/tenant-a/a-1', ATS);
      expect(portal.resolution_note).toBe('The skill was recorded in error.');
      await s.ingest.ingest(a1Snapshot(), ATS); // the ATS re-sends the same snapshot
      const live = [...s.mem.state.assertions.values()].filter((a) => a.source_tenant_id === 'tenant-a' && JSON.stringify(a.payload).includes('TypeScript'));
      expect(live.map((a) => a.current_status)).toEqual(['REVOKED']);
    });

    it('uphold: DISPUTED → VALID (DISPUTE_RESOLVED)', async () => {
      const skillA = find('tenant-a', 'SKILL', 'TypeScript');
      const d = await open(skillA.id);
      await s.disputes.triage(d.dispute_id, act('tenant-a'), ATS, NOW);
      expect((await s.disputes.uphold(d.dispute_id, act('tenant-a', { note: 'Confirmed with the talent.' }), ATS, NOW)).status).toBe('RESOLVED_UPHELD');
      expect(status(skillA.id)).toBe('VALID');
      expect(events(skillA.id).slice(-1)).toEqual(['DISPUTE_RESOLVED']);
      // terminal: a further disposition is a no-op
      expect((await s.disputes.correct(d.dispute_id, act('tenant-a', { note: 'x' }), ATS)).status).toBe('RESOLVED_UPHELD');
    });

    it('extend: reinvestigation + 15 days, ONCE (422 DISPUTE_EXTENSION_USED)', async () => {
      const d = await open(find('tenant-a', 'SKILL', 'TypeScript').id);
      await s.disputes.extend(d.dispute_id, act('tenant-a'), ATS, NOW);
      const view = await s.disputes.getForTenant('tenant-a', d.dispute_id, ATS);
      expect(Date.parse(view.sla.reinvestigation_due_at) - Date.parse(d.sla.reinvestigation_due_at)).toBe(15 * DAY);
      expect(view.sla.reinvestigation_extended_at).toBe(NOW.toISOString());
      expect(await code(s.disputes.extend(d.dispute_id, act('tenant-a'), ATS))).toBe('DISPUTE_EXTENSION_USED');
    });

    it('request-info (TENANT note) and respond (TALENT, replay is a no-op, 422 once closed)', async () => {
      const d = await open(find('tenant-a', 'SKILL', 'TypeScript').id);
      await s.disputes.requestInfo(d.dispute_id, act('tenant-a', { note: 'Which employer?' }), ATS);
      await s.disputes.respond(d.dispute_id, { portal_context: A1, statement: 'Acme.' }, ATS);
      const view = await s.disputes.respond(d.dispute_id, { portal_context: A1, statement: 'Acme.' }, ATS);
      expect(view.statements.map((x) => `${x.author}:${x.statement}`)).toEqual(['TALENT:This title is wrong.', 'TENANT:Which employer?', 'TALENT:Acme.']);
      await s.disputes.withdraw(d.dispute_id, { portal_context: A1 }, ATS, NOW);
      expect(await code(s.disputes.respond(d.dispute_id, { portal_context: A1, statement: 'more' }, ATS))).toBe('DISPUTE_NOT_OPEN');
    });

    it('withdraw: a triaged dispute returns the assertion to VALID; untriaged leaves it; terminal withdraw is idempotent', async () => {
      const skillA = find('tenant-a', 'SKILL', 'TypeScript');
      const d = await open(skillA.id);
      await s.disputes.triage(d.dispute_id, act('tenant-a'), ATS, NOW);
      const w = await s.disputes.withdraw(d.dispute_id, { portal_context: A1, actor: 'portal-user-9' }, ATS, NOW);
      expect(w.status).toBe('WITHDRAWN');
      expect(status(skillA.id)).toBe('VALID');
      const resolved = s.mem.state.events.filter((e) => e.assertion_id === skillA.id && e.event_type === 'DISPUTE_RESOLVED');
      expect(resolved[0]?.actor).toBe('talent:portal-user-9');
      expect((await s.disputes.withdraw(d.dispute_id, { portal_context: A1 }, ATS)).status).toBe('WITHDRAWN');

      const skillB = find('tenant-b', 'SKILL', 'Go');
      const d2 = await open(skillB.id, B1);
      await s.disputes.withdraw(d2.dispute_id, { portal_context: B1 }, ATS, NOW);
      expect(status(skillB.id)).toBe('VALID');
      expect(events(skillB.id)).not.toContain('DISPUTE_RESOLVED');
    });

    it('RESOLVED_NO_TRANSITION when the assertion was retired after open (triage)', async () => {
      const skillA = find('tenant-a', 'SKILL', 'TypeScript');
      const d = await open(skillA.id);
      await s.ingest.ingest({ ...a1Snapshot(), assertions: [title('Engineer', '2026-10-01T00:00:00.000Z')] }, ATS);
      expect((await s.disputes.triage(d.dispute_id, act('tenant-a'), ATS, NOW)).status).toBe('RESOLVED_NO_TRANSITION');
      expect((await s.disputes.getForTenant('tenant-a', d.dispute_id, ATS)).no_transition_reason).toBe('assertion not disputable');
      expect(status(skillA.id)).toBe('SUPERSEDED');
    });

    it('portal list by reference; an unknown reference contributes nothing; 400 without a reference', async () => {
      const d = await open(find('tenant-a', 'SKILL', 'TypeScript').id);
      expect((await s.disputes.listForPortal(['ARAMO_ATS/tenant-a/a-1', 'ARAMO_ATS/tenant-x/x-9'], ATS, undefined)).items.map((i) => i.dispute_id)).toEqual([d.dispute_id]);
      expect((await s.disputes.listForPortal('ARAMO_ATS/tenant-x/x-9', ATS, undefined)).items).toEqual([]);
      expect(await code(s.disputes.listForPortal(undefined, ATS, undefined))).toBe('INVALID_REQUEST');
      expect(await code(s.disputes.getForPortal(d.dispute_id, 'ARAMO_ATS/tenant-x/x-9', ATS))).toBe('NOT_FOUND');
    });
  });

  // ── access matrix ──────────────────────────────────────────────────────────

  describe('tenant access matrix', () => {
    it('a tenant without a reference: 404 (get + actions), empty list; an unentitled tenant: 403', async () => {
      const d = await open(find('tenant-a', 'SKILL', 'TypeScript').id);
      expect(await code(s.disputes.getForTenant('tenant-c', d.dispute_id, ATS))).toBe('NOT_FOUND');
      expect(await code(s.disputes.triage(d.dispute_id, act('tenant-c'), ATS))).toBe('NOT_FOUND');
      expect((await s.disputes.listForTenant('tenant-c', ATS, {})).items).toEqual([]);
      expect(await code(s.disputes.getForTenant('tenant-d', d.dispute_id, ATS))).toBe('NOT_ENTITLED');
      expect(await code(s.disputes.listForTenant('tenant-d', ATS, {}))).toBe('NOT_ENTITLED');
      expect(await code(s.disputes.triage(d.dispute_id, act('tenant-d'), ATS))).toBe('NOT_ENTITLED');
      expect(await code(s.proposals.list('tenant-d', ATS, {}))).toBe('NOT_ENTITLED');
      expect(await code(s.contradictions.resolve({ ...A1, source_tenant_id: 'tenant-d' }, d.assertion_id, { resolution: 'KEEP', reason: 'r', actor: 'u' }, ATS))).toBe('NOT_ENTITLED');
    });

    it('TI_CROSS_TENANT_READ_ENABLED=false hides a dispute of another tenant’s assertion; true shows it (contributor OTHER_SOURCE)', async () => {
      const d = await open(find('tenant-b', 'SKILL', 'Go').id, B1);
      expect((await s.disputes.listForTenant('tenant-a', ATS, {})).items).toEqual([]);
      expect(await code(s.disputes.getForTenant('tenant-a', d.dispute_id, ATS))).toBe('NOT_FOUND');
      expect(await code(s.disputes.triage(d.dispute_id, act('tenant-a'), ATS))).toBe('NOT_FOUND');
      const own = await s.disputes.listForTenant('tenant-b', ATS, {});
      expect(own.items.map((i) => [i.dispute_id, i.contributed_by, i.external_talent_ids])).toEqual([[d.dispute_id, 'REQUESTING_TENANT', ['b-1']]]);
      setCross(true);
      const cross = await s.disputes.listForTenant('tenant-a', ATS, {});
      expect(cross.items.map((i) => [i.dispute_id, i.contributed_by, i.external_talent_ids])).toEqual([[d.dispute_id, 'OTHER_SOURCE', ['a-1', 'a-2']]]);
    });

    it('an erased reference drops the tenant’s visibility; list status filter and keyset paging', async () => {
      const d1 = await open(find('tenant-a', 'SKILL', 'TypeScript').id);
      const d2 = await open(find('tenant-a', 'TITLE', 'Manager').id, A1);
      // Same opened_at → keyset order falls back to the id.
      const [first, second] = [d1.dispute_id, d2.dispute_id].sort();
      const p1 = await s.disputes.listForTenant('tenant-a', ATS, { limit: '1' });
      expect(p1.items.map((i) => i.dispute_id)).toEqual([first]);
      const p2 = await s.disputes.listForTenant('tenant-a', ATS, { limit: '1', cursor: p1.next_cursor });
      expect(p2.items.map((i) => i.dispute_id)).toEqual([second]);
      expect(p2.next_cursor).toBeNull();
      expect((await s.disputes.listForTenant('tenant-a', ATS, { status: 'RESOLVED_UPHELD' })).items).toEqual([]);
      expect(await code(s.disputes.listForTenant('tenant-a', ATS, { status: 'BOGUS' }))).toBe('INVALID_REQUEST');
      for (const t of [A1, A2]) await s.ingest.erase({ ...t, source_event_id: `erase-${t.external_talent_id}`, occurred_at: NOW.toISOString() }, ATS);
      expect((await s.disputes.listForTenant('tenant-a', ATS, {})).items).toEqual([]);
    });
  });

  // ── proposals ──────────────────────────────────────────────────────────────

  describe('proposals', () => {
    const openOf = async (tenant: string) => (await s.proposals.list(tenant, ATS, {})).items;

    it('generated per tenant view: A → RESOLVE_CONTRADICTION ×2 + VERIFY_CONTACT ×2 (single source); B → VERIFY_CONTACT ×1; C → none', async () => {
      const a = await openOf('tenant-a');
      expect(a.map((p) => p.kind).sort()).toEqual(['RESOLVE_CONTRADICTION', 'RESOLVE_CONTRADICTION', 'VERIFY_CONTACT', 'VERIFY_CONTACT']);
      expect(a.filter((p) => p.kind === 'RESOLVE_CONTRADICTION').map((p) => p.assertion_type)).toEqual(['TITLE', 'TITLE']);
      const contacts = a.filter((p) => p.kind === 'VERIFY_CONTACT');
      expect(contacts.map((p) => p.identifier_type).sort()).toEqual(['EMAIL', 'PHONE']);
      expect(contacts.every((p) => /^[a-f0-9]{64}$/.test(p.identifier_digest ?? ''))).toBe(true);
      expect(JSON.stringify(a)).not.toContain('priya@x.io');
      expect(a[0]?.external_talent_ids).toEqual(['a-1', 'a-2']);
      expect((await openOf('tenant-b')).map((p) => [p.kind, p.identifier_type])).toEqual([['VERIFY_CONTACT', 'EMAIL']]);
      expect(await openOf('tenant-c')).toEqual([]);
    });

    it('dismiss: justification required; OPEN-only (409); a dismissed basis is never re-opened by regeneration', async () => {
      const p = (await openOf('tenant-a')).find((x) => x.kind === 'VERIFY_CONTACT' && x.identifier_type === 'EMAIL');
      if (!p) throw new Error('missing');
      expect(await code(s.proposals.dismiss(p.proposal_id, act('tenant-a'), ATS))).toBe('INVALID_REQUEST');
      expect(await code(s.proposals.dismiss(p.proposal_id, act('tenant-b', { justification: 'n/a' }), ATS))).toBe('NOT_FOUND');
      const d = await s.proposals.dismiss(p.proposal_id, act('tenant-a', { justification: 'Known contact.' }), ATS, NOW);
      expect([d.status, d.justification, d.acted_at]).toEqual(['DISMISSED', 'Known contact.', NOW.toISOString()]);
      expect(await code(s.proposals.dismiss(p.proposal_id, act('tenant-a', { justification: 'again' }), ATS))).toBe('PROPOSAL_NOT_OPEN');
      await s.projection.rebuild(subjectId());
      const rows = [...s.mem.state.proposals.values()].filter((x) => x.basis_ref === `identifier:${p.identifier_digest}` && x.source_tenant_id === 'tenant-a');
      expect(rows.map((x) => x.status)).toEqual(['DISMISSED']);
    });

    it('act: records the action (executes nothing); 409 once terminal', async () => {
      const p = (await openOf('tenant-a')).find((x) => x.kind === 'RESOLVE_CONTRADICTION');
      if (!p) throw new Error('missing');
      expect(await code(s.proposals.act(p.proposal_id, act('tenant-a', { action: 'DELETE_EVERYTHING' }), ATS))).toBe('INVALID_REQUEST');
      const before = structuredClone([...s.mem.state.assertions.values()].map((a) => a.current_status));
      const done = await s.proposals.act(p.proposal_id, act('tenant-a', { action: 'CONTRADICTION_RESOLVED', note: 'Handled.' }), ATS, NOW);
      expect([done.status, done.action]).toEqual(['ACTED', 'CONTRADICTION_RESOLVED']);
      expect([...s.mem.state.assertions.values()].map((a) => a.current_status)).toEqual(before);
      expect(await code(s.proposals.act(p.proposal_id, act('tenant-a', { action: 'RECORD_UPDATED' }), ATS))).toBe('PROPOSAL_NOT_OPEN');
    });

    it('SETTLED when the trigger clears: a TI email verification adds an independent source, so single_source_only clears and BOTH VERIFY_CONTACT rows settle', async () => {
      const created = await s.verification.create({ source_reference: A1, identifier_type: 'EMAIL', value: 'priya@x.io' }, ATS);
      await s.verification.confirm(created.verification_id, { code: codeOf(s.mem, s.codes, created.verification_id) });
      const rows = [...s.mem.state.proposals.values()].filter((x) => x.source_tenant_id === 'tenant-a' && x.kind === 'VERIFY_CONTACT');
      expect(rows.map((x) => [x.identifier_type, x.status]).sort()).toEqual([
        ['EMAIL', 'SETTLED'],
        ['PHONE', 'SETTLED'],
      ]);
      expect(s.mem.state.trust.get(subjectId())?.single_source_only).toBe(false);
      expect(rows.find((x) => x.status === 'SETTLED')?.justification).toBe('trigger cleared');
    });

    it('an erased tenant reference hides the tenant’s proposals', async () => {
      for (const t of [A1, A2]) await s.ingest.erase({ ...t, source_event_id: `erase-${t.external_talent_id}`, occurred_at: NOW.toISOString() }, ATS);
      expect(await openOf('tenant-a')).toEqual([]);
      expect((await openOf('tenant-b')).length).toBe(1);
    });
  });

  // ── contradiction resolution ───────────────────────────────────────────────

  describe('contradiction resolution', () => {
    const body = (resolution: 'KEEP' | 'RETRACT') => ({ resolution, reason: 'Checked with the talent.', actor: 'user-1' });

    it('KEEP: RECONCILES link + CONTRADICTION_RESOLVED event + VALID; the projection stops pairing; proposals settle', async () => {
      const eng = find('tenant-a', 'TITLE', 'Engineer');
      const mgr = find('tenant-a', 'TITLE', 'Manager');
      const r = await s.contradictions.resolve(A1, eng.id, body('KEEP'), ATS, NOW);
      expect(r).toEqual({ assertion_id: eng.id, resolution: 'KEEP', status: 'VALID', reconciled_with: [mgr.id] });
      expect(s.mem.state.links.filter((l) => l.link_type === 'RECONCILES').map((l) => [l.from_assertion_id, l.to_assertion_id])).toEqual([[eng.id, mgr.id]]);
      const ev = s.mem.state.events.find((e) => e.assertion_id === eng.id && e.event_type === 'CONTRADICTION_RESOLVED');
      expect(ev?.actor).toBe('tenant:ARAMO_ATS:tenant-a:user-1');
      expect(ev?.details).toMatchObject({ resolution: 'KEEP', reason: 'Checked with the talent.', source_tenant_id: 'tenant-a' });
      // after the post-commit rebuild: Engineer VALID globally; Manager still contradicted globally by tenant-b's Director
      expect(status(eng.id)).toBe('VALID');
      expect(status(mgr.id)).toBe('CONTRADICTED');
      // …but tenant A's own view no longer has a contradiction
      const profile = await s.reads.profile({ client_id: 'r', source_system_id: 'ARAMO_ATS' }, A1, NOW);
      expect(profile.trust.open_contradiction_count).toBe(0);
      const a = [...s.mem.state.proposals.values()].filter((x) => x.source_tenant_id === 'tenant-a' && x.kind === 'RESOLVE_CONTRADICTION');
      expect(a.map((x) => x.status)).toEqual(['SETTLED', 'SETTLED']);
      expect(await code(s.contradictions.resolve(A1, eng.id, body('KEEP'), ATS))).toBe('ASSERTION_NOT_CONTRADICTED');
    });

    it('RETRACT: own assertion → REVOKED; another tenant’s assertion → 403 (cross-tenant on) / 404 (off); not contradicted → 422', async () => {
      const dir = find('tenant-b', 'TITLE', 'Director');
      expect(await code(s.contradictions.resolve(A1, dir.id, body('RETRACT'), ATS))).toBe('NOT_FOUND');
      setCross(true);
      expect(await code(s.contradictions.resolve(A1, dir.id, body('RETRACT'), ATS))).toBe('RESOLUTION_NOT_PERMITTED');
      setCross(false);
      expect(await code(s.contradictions.resolve(A1, find('tenant-a', 'SKILL', 'TypeScript').id, body('KEEP'), ATS))).toBe('ASSERTION_NOT_CONTRADICTED');
      const eng = find('tenant-a', 'TITLE', 'Engineer');
      const r = await s.contradictions.resolve(A2, eng.id, body('RETRACT'), ATS, NOW);
      expect([r.status, status(eng.id)]).toEqual(['REVOKED', 'REVOKED']);
      expect(events(eng.id).slice(-1)).toEqual(['CONTRADICTION_RESOLVED']);
      expect(await code(s.contradictions.resolve(A1, eng.id, { resolution: 'MAYBE', reason: 'x', actor: 'u' }, ATS))).toBe('INVALID_REQUEST');
    });
  });

  // ── verification status (M-1, M-6) ─────────────────────────────────────────

  describe('verification status', () => {
    it('M-1: VERIFIED (re-verification due +365 d), PENDING (code expiry), UNVERIFIED; masked; 404 unknown reference', async () => {
      const before = await s.verificationStatus.forReference(A1, ATS, NOW);
      expect(before.items).toEqual([
        { identifier_type: 'EMAIL', value_masked: 'p***@x.io', status: 'VERIFIED', expires_at: new Date(Date.parse(VERIFIED.verified_at) + 365 * DAY).toISOString() },
        { identifier_type: 'PHONE', value_masked: '***00', status: 'UNVERIFIED', expires_at: null },
      ]);
      const pending = await s.verification.create({ source_reference: A1, identifier_type: 'PHONE', value: '+1 555 010 2000' }, ATS, NOW);
      const after = await s.verificationStatus.forReference(A1, ATS, NOW);
      expect(after.items[1]).toEqual({ identifier_type: 'PHONE', value_masked: '***00', status: 'PENDING', expires_at: pending.expires_at });
      expect((await s.verificationStatus.forReference(A2, ATS, NOW)).items.map((i) => i.identifier_type)).toEqual(['EMAIL']);
      expect(await code(s.verificationStatus.forReference({ ...A1, external_talent_id: 'zzz' }, ATS))).toBe('REFERENCE_NOT_FOUND');
    });

    it('M-6: de-duplicated across the passed references; unknown ones ignored; the TI outcome assertion once verified', async () => {
      const refs = ['ARAMO_ATS/tenant-a/a-1', 'ARAMO_ATS/tenant-b/b-1', 'ARAMO_ATS/tenant-q/q-1'];
      const first = await s.verificationStatus.forPortal(refs, ATS, NOW);
      expect(first.items.map((i) => [i.identifier_type, i.status, i.assertion_id])).toEqual([
        ['EMAIL', 'VERIFIED', null],
        ['PHONE', 'UNVERIFIED', null],
      ]);
      const created = await s.verification.create({ source_reference: B1, identifier_type: 'EMAIL', value: 'priya@x.io' }, ATS);
      await s.verification.confirm(created.verification_id, { code: codeOf(s.mem, s.codes, created.verification_id) });
      const outcome = [...s.mem.state.assertions.values()].find((a) => a.assertion_type === 'VERIFICATION_OUTCOME');
      const second = await s.verificationStatus.forPortal(refs, ATS, NOW);
      expect(second.items[0]?.assertion_id).toBe(outcome?.id);
      expect(JSON.stringify(second)).not.toContain('priya@x.io');
      expect(await code(s.verificationStatus.forPortal(['OTHER/t/x'], ATS))).toBe('INVALID_REQUEST');
    });
  });
});
