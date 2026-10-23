import { beforeEach, describe, expect, it } from 'vitest';

import {
  GovIdTokenizer,
  IdentityMergeSplitService,
  IdentityResolutionService,
  MergeSplitError,
  TalentIngestService,
} from '../index.js';

import { snapshot } from './support/fixtures.js';
import { InMemoryIntelligence } from './support/in-memory-intelligence.js';

// ATI-SEP-1 T3 (ADR-0036 §5.5) — merge / split are transactional, recorded in
// MergeSplitEvent, re-point every row, and are reversible: split(restore) after
// merge returns the exact pre-merge state.

const ATS = { client_id: 'ats', source_system_id: 'ARAMO_ATS' };

describe('IdentityMergeSplitService', () => {
  let mem: InMemoryIntelligence;
  let ingest: TalentIngestService;
  let ms: IdentityMergeSplitService;
  let A: string;
  let B: string;

  beforeEach(async () => {
    mem = new InMemoryIntelligence();
    ingest = new TalentIngestService(mem, new IdentityResolutionService(), GovIdTokenizer.withKey('k'.repeat(32)));
    ms = new IdentityMergeSplitService(mem);
    A = (await ingest.ingest(snapshot({ tenant: 't-a', identity: { names: { first: 'Priya', last: 'Raman' }, emails: [{ value: 'a@x.io', is_primary: true }] } }), ATS)).intelligence_subject_id;
    B = (await ingest.ingest(snapshot({ tenant: 't-b', identity: { names: { first: 'Priya', last: 'Raman' }, emails: [{ value: 'b@x.io', is_primary: true }] } }), ATS)).intelligence_subject_id;
    await mem.run((r) => r.artifacts.upsertPolicy('DEGREE_CERTIFICATE', false));
    await mem.run((r) =>
      r.artifacts.create({ subject_id: A, document_type: 'DEGREE_CERTIFICATE', storage_key: 'ti/a/1', sha256: 'f'.repeat(64), retrieved_at: new Date() }),
    );
    await mem.run((r) => r.facts.upsert({ subject_id: A, fact_type: 'TITLE', fact_key: '', value: 'Engineer', supporting_assertion_ids: [] }));
  });

  function ownership() {
    const by = <T extends { id: string; subject_id: string }>(m: Iterable<T>) =>
      Object.fromEntries([...m].map((r) => [r.id, r.subject_id]));
    return {
      references: by(mem.state.references.values()),
      assertions: by(mem.state.assertions.values()),
      identifiers: by(mem.state.identifiers.values()),
      artifacts: by(mem.state.artifacts.values()),
      conflicts: by(mem.state.conflicts.values()),
      subjects: Object.fromEntries(
        [...mem.state.subjects.values()].map((s) => [s.id, [s.resolution_status, s.merged_into_id, s.access_state]]),
      ),
    };
  }

  it('merge re-points every row, marks the from-subject MERGED, drops projections, records the event', async () => {
    const event = await ms.merge(A, B, 'operator:1', 'same human, verified by phone call');
    expect(event).toMatchObject({ kind: 'MERGE', from_subject_id: A, into_subject_id: B, actor: 'operator:1' });
    const own = ownership();
    for (const kind of ['references', 'assertions', 'identifiers', 'artifacts'] as const) {
      expect(Object.values(own[kind]).every((s) => s === B)).toBe(true);
    }
    expect(own.subjects[A]).toEqual(['MERGED', B, 'ACTIVE']);
    expect(mem.state.facts.size).toBe(0);
    const moved = event.moved as { assertion_ids: string[]; reference_ids: string[] };
    expect(moved.reference_ids).toHaveLength(1);
    expect(mem.state.events.filter((e) => e.event_type === 'REPOINTED')).toHaveLength(moved.assertion_ids.length);
  });

  it('merge → split(restore) round-trips to the exact pre-merge ownership and status', async () => {
    const before = ownership();
    const merge = await ms.merge(A, B, 'op', 'merge');
    const split = await ms.split(B, {}, 'op', 'undo', { restoreMergeEventId: merge.id });
    expect(split).toMatchObject({ kind: 'SPLIT', from_subject_id: B, into_subject_id: A });
    expect((split.moved as { restores_merge_event_id: string }).restores_merge_event_id).toBe(merge.id);
    expect(ownership()).toEqual(before);
    expect(mem.state.mergeSplit.map((e) => e.kind)).toEqual(['MERGE', 'SPLIT']);
  });

  it('after a merge, a new snapshot of a moved reference lands on the survivor; restore carries it back', async () => {
    const merge = await ms.merge(A, B, 'op', 'merge');
    const res = await ingest.ingest(
      snapshot({
        tenant: 't-a',
        identity: { names: { first: 'Priya', last: 'Raman' }, emails: [{ value: 'a@x.io', is_primary: true }] },
        assertions: [{ assertion_type: 'SKILL', payload: { name: 'Go' }, source_kind: 'RECRUITER', observed_at: '2026-10-24T00:00:00.000Z' }],
      }),
      ATS,
    );
    expect(res.intelligence_subject_id).toBe(B);
    await ms.split(B, {}, 'op', 'undo', { restoreMergeEventId: merge.id });
    const go = [...mem.state.assertions.values()].find((a) => (a.payload as { name?: string }).name === 'Go');
    expect(go?.subject_id).toBe(A);
  });

  it('a plain split moves the selection (and everything sourced from a moved reference) to a NEW PROVISIONAL subject', async () => {
    await ms.merge(A, B, 'op', 'merge');
    const refA = [...mem.state.references.values()].find((r) => r.source_tenant_id === 't-a')!;
    const ev = await ms.split(B, { reference_ids: [refA.id] }, 'op', 'wrongly merged');
    const target = ev.into_subject_id;
    expect(target).not.toBe(A);
    expect(mem.state.subjects.get(target)?.resolution_status).toBe('PROVISIONAL');
    const sourced = [...mem.state.assertions.values()].filter((a) => a.source_reference_id === refA.id);
    expect(sourced.length).toBeGreaterThan(0);
    expect(sourced.every((a) => a.subject_id === target)).toBe(true);
    expect([...mem.state.identifiers.values()].filter((i) => i.source_reference_id === refA.id).every((i) => i.subject_id === target)).toBe(true);
  });

  it('refuses self-merge, merging a MERGED subject, foreign selections, empty splits and bad restore ids — atomically', async () => {
    await expect(ms.merge(A, A, 'op', 'x')).rejects.toBeInstanceOf(MergeSplitError);
    await ms.merge(A, B, 'op', 'x');
    await expect(ms.merge(A, B, 'op', 'x')).rejects.toThrow(/already merged/);
    const before = structuredClone(mem.state);
    await expect(ms.split(B, { assertion_ids: ['00000000-0000-0000-0000-000000000000'] }, 'op', 'x')).rejects.toThrow(/do not belong/);
    await expect(ms.split(B, {}, 'op', 'x')).rejects.toThrow(/nothing selected/);
    await expect(ms.split(B, {}, 'op', 'x', { restoreMergeEventId: 'nope' })).rejects.toThrow(/MERGE event/);
    expect(mem.state.subjects.size).toBe(before.subjects.size);
    expect(mem.state.mergeSplit).toHaveLength(before.mergeSplit.length);
  });
});
