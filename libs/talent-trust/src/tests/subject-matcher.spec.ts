import { describe, expect, it, vi } from 'vitest';

import { SubjectMatcherService } from '../lib/subject-matcher.service.js';
import type {
  SubjectAnchorRow,
  TalentTrustRepository,
} from '../lib/talent-trust.repository.js';

// TR-2a-2 — matcher MECHANISM proof (mocked repo, no DB). ADVISE-ONLY (R1): the
// matcher writes an advisory (upsertMatchAdvisory) and takes ZERO merge action —
// setSubjectMergeState is NEVER called. This is the mechanism half of the proof;
// the integration spec proves the effect (subjects unchanged after matching).

const TENANT = '11111111-1111-7111-8111-111111111111';
const SUBJ_ME = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const SUBJ_OTHER = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';

function anchor(subject_id: string, id: string, normalized_value: string): SubjectAnchorRow {
  return {
    id,
    subject_id,
    tenant_id: TENANT,
    anchor_kind: 'EMAIL',
    normalized_value,
    source_evidence_id: `ev-${id}`,
    // TR-2a-B2 — non-confirming (no channel confirms today); confirmed_kinds stays
    // empty so the advise band is unchanged from the TR-2a-2 semantics.
    source_class: 'THIRD_PARTY_UNVERIFIED',
    created_at: new Date('2026-07-03T00:00:00Z'),
  };
}

describe('SubjectMatcherService — advise-only mechanism', () => {
  it('writes an advisory and NEVER merges (no setSubjectMergeState)', async () => {
    const upsertMatchAdvisory = vi.fn(async (i: unknown) => ({ id: 'advisory-1', ...(i as object) }));
    const setSubjectMergeState = vi.fn();
    const mergeSubjects = vi.fn();

    const repo = {
      listAnchorsBySubject: vi.fn(async (subjectId: string) =>
        subjectId === SUBJ_ME
          ? [anchor(SUBJ_ME, 'me-e', 'shared@example.com')]
          : [anchor(SUBJ_OTHER, 'other-e', 'shared@example.com')],
      ),
      findAnchorsByValue: vi.fn(async () => [
        anchor(SUBJ_ME, 'me-e', 'shared@example.com'),
        anchor(SUBJ_OTHER, 'other-e', 'shared@example.com'),
      ]),
      // TR-6 B1 (D2) — the matcher now maps each sharer to its ACTIVE fixpoint
      // before keying. Both subjects are ACTIVE (their own fixpoint) here, so the
      // advisory keying is unchanged (SUBJ_ME, SUBJ_OTHER).
      resolveActiveFixpoint: vi.fn(async (id: string) => ({ kind: 'ACTIVE', subjectId: id })),
      upsertMatchAdvisory,
      setSubjectMergeState,
      // present on the real repo — assert the matcher never reaches for merge.
      mergeSubjects,
    } as unknown as TalentTrustRepository;

    const svc = new SubjectMatcherService(repo);
    const advisories = await svc.matchSubject(TENANT, SUBJ_ME);

    expect(advisories).toHaveLength(1);
    expect(upsertMatchAdvisory).toHaveBeenCalledTimes(1);
    // The one merge-capable repo method the matcher must NEVER touch.
    expect(setSubjectMergeState).not.toHaveBeenCalled();

    // The advisory carries the canonical pair (a < b) + PENDING-review defaults.
    const arg = upsertMatchAdvisory.mock.calls[0]![0] as {
      subject_a_id: string;
      subject_b_id: string;
      advise_band: string;
    };
    expect(arg.subject_a_id < arg.subject_b_id).toBe(true);
    expect([arg.subject_a_id, arg.subject_b_id].sort()).toEqual([SUBJ_ME, SUBJ_OTHER].sort());
    expect(arg.advise_band).toBe('ADVISE_WEAK');
  });

  it('a subject with no anchors produces no advisories (and no merge)', async () => {
    const upsertMatchAdvisory = vi.fn();
    const setSubjectMergeState = vi.fn();
    const repo = {
      listAnchorsBySubject: vi.fn(async () => [] as SubjectAnchorRow[]),
      findAnchorsByValue: vi.fn(),
      upsertMatchAdvisory,
      setSubjectMergeState,
    } as unknown as TalentTrustRepository;

    const svc = new SubjectMatcherService(repo);
    expect(await svc.matchSubject(TENANT, SUBJ_ME)).toEqual([]);
    expect(upsertMatchAdvisory).not.toHaveBeenCalled();
    expect(setSubjectMergeState).not.toHaveBeenCalled();
  });
});
