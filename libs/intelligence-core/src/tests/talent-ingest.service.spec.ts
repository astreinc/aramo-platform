import { beforeEach, describe, expect, it } from 'vitest';

import {
  EventIdReusedError,
  GovIdTokenizationUnavailableError,
  GovIdTokenizer,
  IdentityResolutionService,
  IngestRejectedError,
  ReferenceErasedError,
  SourceSystemMismatchError,
  TalentIngestService,
} from '../index.js';

import { snapshot, VERIFIED } from './support/fixtures.js';
import { InMemoryIntelligence } from './support/in-memory-intelligence.js';

// ATI-SEP-1 T2 + T3 — the ingestion pipeline end to end over in-memory
// repositories: admission, idempotency, snapshot semantics, identity resolution
// (Priya examples), conflicts, erasure → AUDIT_RETAINED.

const ATS = { client_id: 'ats-client', source_system_id: 'ARAMO_ATS' };
const KEY = 'k'.repeat(32);

describe('TalentIngestService', () => {
  let mem: InMemoryIntelligence;
  let svc: TalentIngestService;

  beforeEach(() => {
    mem = new InMemoryIntelligence();
    svc = new TalentIngestService(mem, new IdentityResolutionService(), GovIdTokenizer.withKey(KEY));
  });

  const subjects = () => [...mem.state.subjects.values()];
  const identifiersOf = (subjectId: string) => [...mem.state.identifiers.values()].filter((i) => i.subject_id === subjectId);
  const assertionsOf = (subjectId: string) => [...mem.state.assertions.values()].filter((a) => a.subject_id === subjectId);
  const conflictsOf = (subjectId: string) => [...mem.state.conflicts.values()].filter((c) => c.subject_id === subjectId);

  it('first snapshot → new PROVISIONAL subject, reference, identifiers, NAME + assertions, outbox, inbox', async () => {
    const res = await svc.ingest(snapshot(), ATS);
    expect(res).toMatchObject({ outcome: 'CREATED', resolution: 'NEW_PROVISIONAL', changed: true, assertions_added: 3, replayed: false });
    const [s] = subjects();
    expect(s).toMatchObject({ id: res.intelligence_subject_id, resolution_status: 'PROVISIONAL', access_state: 'ACTIVE' });
    expect(identifiersOf(s!.id).map((i) => [i.identifier_type, i.normalized_value, i.verification_status])).toEqual([
      ['EMAIL', 'priya@example.com', 'VERIFIED'],
      ['PHONE', '+15550102000', 'UNVERIFIED'],
    ]);
    expect(assertionsOf(s!.id).map((a) => [a.assertion_type, a.admission_class, a.verification_status])).toEqual([
      ['NAME', 'B', 'DECLARED'],
      ['SKILL', 'A', 'DECLARED'],
      ['TITLE', 'A', 'DECLARED'],
    ]);
    expect(mem.state.events.map((e) => e.event_type)).toEqual(['ASSERTED', 'ASSERTED', 'ASSERTED']);
    expect(mem.state.outbox).toHaveLength(1);
    expect(mem.state.outbox[0]).toMatchObject({ event_type: 'golden_talent.profile_updated', subject_id: s!.id, payload: { intelligence_subject_id: s!.id } });
    expect(mem.state.inbox.size).toBe(1);
  });

  it('a replayed event returns the stored outcome and writes nothing', async () => {
    const body = snapshot();
    const first = await svc.ingest(body, ATS);
    const before = structuredClone(mem.state);
    const again = await svc.ingest(body, ATS);
    expect(again).toEqual({ ...first, replayed: true });
    expect(mem.state.assertions.size).toBe(before.assertions.size);
    expect(mem.state.outbox).toHaveLength(before.outbox.length);
  });

  it('an event id reused for another reference is refused (409 class)', async () => {
    const body = snapshot();
    await svc.ingest(body, ATS);
    await expect(svc.ingest({ ...body, external_talent_id: 'talent-2' }, ATS)).rejects.toBeInstanceOf(EventIdReusedError);
    const sameIdAsErasure = {
      source_system_id: 'ARAMO_ATS',
      source_tenant_id: body.source_tenant_id,
      external_talent_id: body.external_talent_id,
      source_event_id: body.source_event_id,
      occurred_at: body.occurred_at,
    };
    await expect(svc.erase(sameIdAsErasure, ATS)).rejects.toBeInstanceOf(EventIdReusedError);
  });

  it('an identical later snapshot (new event) dedupes by content hash: nothing changes, no outbox', async () => {
    await svc.ingest(snapshot(), ATS);
    const res = await svc.ingest(snapshot({ occurred_at: '2026-10-24T10:00:00.000Z' }), ATS);
    expect(res).toMatchObject({ outcome: 'UPDATED', resolution: 'EXISTING_REFERENCE', changed: false, assertions_added: 0, assertions_superseded: 0 });
    expect(mem.state.assertions.size).toBe(3);
    expect(mem.state.outbox).toHaveLength(1);
  });

  it('a value absent from the next snapshot is SUPERSEDED (event + status); a single-valued replacement links SUPERSEDES', async () => {
    await svc.ingest(snapshot(), ATS);
    const res = await svc.ingest(
      snapshot({
        assertions: [
          { assertion_type: 'TITLE', payload: { value: 'Staff Engineer' }, source_kind: 'RECRUITER', observed_at: '2026-10-24T00:00:00.000Z' },
        ],
      }),
      ATS,
    );
    expect(res).toMatchObject({ changed: true, assertions_added: 1, assertions_superseded: 2 });
    const all = [...mem.state.assertions.values()];
    expect(all.filter((a) => a.current_status === 'SUPERSEDED').map((a) => a.assertion_type).sort()).toEqual(['SKILL', 'TITLE']);
    expect(mem.state.events.filter((e) => e.event_type === 'SUPERSEDED')).toHaveLength(2);
    expect(mem.state.links).toHaveLength(1);
    expect(mem.state.links[0]?.link_type).toBe('SUPERSEDES');
    expect(mem.state.outbox).toHaveLength(2);
    // a superseded value re-asserted later is a NEW assertion (history kept)
    await svc.ingest(snapshot(), ATS);
    expect(all.length + 2).toBe(mem.state.assertions.size);
  });

  it('work authorization from a résumé is stored non-authoritative (TI computes the flag)', async () => {
    await svc.ingest(
      snapshot({
        assertions: [
          { assertion_type: 'WORK_AUTHORIZATION', payload: { status: 'AUTHORIZED' }, source_kind: 'RESUME_DERIVED', observed_at: '2026-10-23T00:00:00.000Z' },
          { assertion_type: 'WORK_AUTHORIZATION', payload: { status: 'CITIZEN' }, source_kind: 'TALENT_SELF', observed_at: '2026-10-23T00:00:00.000Z' },
        ],
      }),
      ATS,
    );
    const wa = [...mem.state.assertions.values()].filter((a) => a.assertion_type === 'WORK_AUTHORIZATION');
    expect(wa.map((a) => (a.payload as { authoritative: boolean }).authoritative)).toEqual([false, true]);
  });

  describe('identity resolution (Priya examples)', () => {
    it('ATS email1 VERIFIED == another source email2 VERIFIED → same subject (position irrelevant), PROVISIONAL → ACTIVE', async () => {
      const a = await svc.ingest(snapshot({ tenant: 'tenant-a' }), ATS);
      const b = await svc.ingest(
        snapshot({
          tenant: 'tenant-b',
          talent: 'b-77',
          identity: {
            names: { first: 'Priya', last: 'Raman' },
            emails: [
              { value: 'p.raman@corp.example', is_primary: true },
              { value: 'PRIYA@example.com ', is_primary: false, verification: { ...VERIFIED } },
            ],
          },
        }),
        ATS,
      );
      expect(b).toMatchObject({ outcome: 'LINKED', resolution: 'VERIFIED_ANCHOR', intelligence_subject_id: a.intelligence_subject_id });
      expect(subjects()).toHaveLength(1);
      expect(subjects()[0]?.resolution_status).toBe('ACTIVE');
      // the second reference's copy of the bound email is recorded UNVERIFIED (never re-bound)
      const emails = identifiersOf(a.intelligence_subject_id).filter((i) => i.normalized_value === 'priya@example.com');
      expect(emails.map((e) => e.verification_status).sort()).toEqual(['UNVERIFIED', 'VERIFIED']);
    });

    it('same VERIFIED phone + different name → same subject + IDENTITY_ATTRIBUTE_CONFLICT', async () => {
      const verifiedPhone = [{ value: '(555) 010-2000', is_primary: true, verification: { ...VERIFIED, method: 'SMS_OTP' } }];
      const a = await svc.ingest(snapshot({ identity: { names: { first: 'Priya', last: 'Raman' }, phones: verifiedPhone } }), ATS);
      const b = await svc.ingest(
        snapshot({ tenant: 'tenant-b', talent: 'x', identity: { names: { first: 'Anita', last: 'Kumar' }, phones: verifiedPhone } }),
        ATS,
      );
      expect(b.intelligence_subject_id).toBe(a.intelligence_subject_id);
      expect(b.conflicts_opened).toBe(1);
      expect(conflictsOf(a.intelligence_subject_id).map((c) => c.conflict_type)).toEqual(['IDENTITY_ATTRIBUTE_CONFLICT']);
      // the same snapshot again does not re-open the conflict
      await svc.ingest(snapshot({ tenant: 'tenant-b', talent: 'x', identity: { names: { first: 'Anita', last: 'Kumar' }, phones: verifiedPhone } }), ATS);
      expect(conflictsOf(a.intelligence_subject_id)).toHaveLength(1);
    });

    it('R3 — an UNVERIFIED match never links', async () => {
      await svc.ingest(snapshot(), ATS);
      const b = await svc.ingest(
        snapshot({ tenant: 'tenant-b', identity: { emails: [{ value: 'priya@example.com', is_primary: true }] } }),
        ATS,
      );
      expect(b.resolution).toBe('NEW_PROVISIONAL');
      expect(subjects()).toHaveLength(2);
    });

    it('verified anchors on two subjects → new PROVISIONAL subject + ANCHOR_CONTRADICTION, no merge', async () => {
      const a = await svc.ingest(snapshot({ tenant: 't1', identity: { emails: [{ value: 'one@x.io', is_primary: true, verification: { ...VERIFIED } }] } }), ATS);
      const b = await svc.ingest(snapshot({ tenant: 't2', identity: { emails: [{ value: 'two@x.io', is_primary: true, verification: { ...VERIFIED } }] } }), ATS);
      const c = await svc.ingest(
        snapshot({
          tenant: 't3',
          identity: {
            emails: [
              { value: 'one@x.io', is_primary: true, verification: { ...VERIFIED } },
              { value: 'two@x.io', is_primary: false, verification: { ...VERIFIED } },
            ],
          },
        }),
        ATS,
      );
      expect(c).toMatchObject({ outcome: 'CREATED', resolution: 'ANCHOR_CONTRADICTION', conflicts_opened: 1 });
      expect(new Set([a.intelligence_subject_id, b.intelligence_subject_id, c.intelligence_subject_id]).size).toBe(3);
      const [conflict] = conflictsOf(c.intelligence_subject_id);
      expect(conflict?.related_subject_ids.sort()).toEqual([a.intelligence_subject_id, b.intelligence_subject_id].sort());
      expect(subjects().every((s) => s.resolution_status !== 'MERGED')).toBe(true);
      // the new subject's copies stay UNVERIFIED — the index binds each to one subject only
      expect(identifiersOf(c.intelligence_subject_id).every((i) => i.verification_status === 'UNVERIFIED')).toBe(true);
    });

    it('R1 — the same reference with an entirely different identity → same subject + REFERENCE_IDENTITY_MUTATION', async () => {
      const a = await svc.ingest(snapshot(), ATS);
      const b = await svc.ingest(
        snapshot({ identity: { names: { first: 'John', last: 'Doe' }, emails: [{ value: 'john@x.io', is_primary: true, verification: { ...VERIFIED } }] } }),
        ATS,
      );
      expect(b).toMatchObject({ resolution: 'EXISTING_REFERENCE', intelligence_subject_id: a.intelligence_subject_id, conflicts_opened: 1 });
      expect(conflictsOf(a.intelligence_subject_id)[0]?.conflict_type).toBe('REFERENCE_IDENTITY_MUTATION');
      // dropped identifiers are SUPERSEDED, the binding of priya@ is released
      const priya = identifiersOf(a.intelligence_subject_id).find((i) => i.normalized_value === 'priya@example.com');
      expect(priya?.status).toBe('SUPERSEDED');
    });

    it('a government id is matched by token only — the raw value is stored nowhere', async () => {
      const gov = [{ value: '123-45-6789', jurisdiction: 'US', identifier_class: 'SSN', verification: { ...VERIFIED, method: 'DOC_CHECK' } }];
      const a = await svc.ingest(snapshot({ identity: { government_ids: gov } }), ATS);
      const b = await svc.ingest(snapshot({ tenant: 'tenant-b', identity: { government_ids: [{ ...gov[0]!, value: '123 45 6789' }] } }), ATS);
      expect(b.intelligence_subject_id).toBe(a.intelligence_subject_id);
      expect(JSON.stringify([...mem.state.identifiers.values(), ...mem.state.references.values(), ...mem.state.inbox.values()])).not.toMatch(/6789/);
    });

    it('a government id without INTELLIGENCE_GOV_ID_TOKEN_KEY fails closed (nothing written)', async () => {
      const noKey = new TalentIngestService(mem, new IdentityResolutionService(), GovIdTokenizer.fromEnv({}));
      await expect(
        noKey.ingest(snapshot({ identity: { government_ids: [{ value: '1', jurisdiction: 'US', identifier_class: 'SSN' }] } }), ATS),
      ).rejects.toBeInstanceOf(GovIdTokenizationUnavailableError);
      expect(mem.state.subjects.size).toBe(0);
    });
  });

  describe('admission + authorization', () => {
    it('an invalid body is refused and quarantined with codes + paths only (never the body)', async () => {
      const body = { ...snapshot(), notes: 'secret recruiter note' };
      await expect(svc.ingest(body, ATS)).rejects.toMatchObject({ code: 'CLASS_C_REJECTED' });
      expect(mem.state.quarantine).toHaveLength(1);
      expect(mem.state.quarantine[0]).toMatchObject({ reason: 'CLASS_C_REJECTED', client_id: 'ats-client', source_event_id: body.source_event_id });
      expect(JSON.stringify(mem.state.quarantine)).not.toContain('secret recruiter note');
      expect(mem.state.subjects.size).toBe(0);
    });

    it('a document is refused as DOCUMENT_REJECTED', async () => {
      const body = snapshot();
      (body.assertions[0]!.payload as Record<string, unknown>)['resume_file'] = 'x';
      const err = await svc.ingest(body, ATS).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IngestRejectedError);
      expect((err as IngestRejectedError).code).toBe('DOCUMENT_REJECTED');
    });

    it('a client may only ingest for its own source system', async () => {
      await expect(svc.ingest(snapshot(), { client_id: 'c', source_system_id: 'OTHER' })).rejects.toBeInstanceOf(SourceSystemMismatchError);
    });
  });

  describe('erasure (Addendum A1)', () => {
    const erasedBody = (tenant: string, talent = 'talent-1') => ({
      source_system_id: 'ARAMO_ATS',
      source_tenant_id: tenant,
      external_talent_id: talent,
      source_event_id: `erase-${tenant}-${talent}-${Math.random()}`,
      occurred_at: '2026-10-25T00:00:00.000Z',
    });

    it('reference → ERASED; subject stays ACTIVE while another ACTIVE reference remains, then AUDIT_RETAINED; evidence kept', async () => {
      const a = await svc.ingest(snapshot({ tenant: 'tenant-a' }), ATS);
      await svc.ingest(snapshot({ tenant: 'tenant-b' }), ATS); // links via the verified email
      const count = mem.state.assertions.size;

      const r1 = await svc.erase(erasedBody('tenant-a'), ATS);
      expect(r1).toMatchObject({ outcome: 'ERASED', intelligence_subject_id: a.intelligence_subject_id, subject_access_state: 'ACTIVE' });
      const r2 = await svc.erase(erasedBody('tenant-b'), ATS);
      expect(r2).toMatchObject({ outcome: 'ERASED', subject_access_state: 'AUDIT_RETAINED' });
      expect(mem.state.subjects.get(a.intelligence_subject_id)?.access_state).toBe('AUDIT_RETAINED');
      expect(mem.state.assertions.size).toBe(count);
      expect([...mem.state.references.values()].every((r) => r.status === 'ERASED' && r.erased_at !== null)).toBe(true);
    });

    it('erasure is idempotent per event, ALREADY_ERASED for a new event, NOT_FOUND for an unknown reference', async () => {
      await svc.ingest(snapshot(), ATS);
      const body = erasedBody('tenant-a');
      const first = await svc.erase(body, ATS);
      expect(await svc.erase(body, ATS)).toEqual({ ...first, replayed: true });
      expect((await svc.erase(erasedBody('tenant-a'), ATS)).outcome).toBe('ALREADY_ERASED');
      expect(await svc.erase(erasedBody('tenant-z'), ATS)).toMatchObject({ outcome: 'NOT_FOUND', intelligence_subject_id: null });
    });

    it('an erased reference cannot receive new data', async () => {
      await svc.ingest(snapshot(), ATS);
      await svc.erase(erasedBody('tenant-a'), ATS);
      await expect(svc.ingest(snapshot(), ATS)).rejects.toBeInstanceOf(ReferenceErasedError);
    });
  });
});
