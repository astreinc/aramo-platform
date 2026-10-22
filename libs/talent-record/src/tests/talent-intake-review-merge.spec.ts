import { describe, expect, it } from 'vitest';

import type { DraftFromResumeResponse } from '../lib/dto/draft-from-resume.response.js';
import {
  composeKeySkills,
  rejectedWorkHistoryWarning,
} from '../lib/resume-extraction/resume-extraction.orchestrator.js';
import {
  applyRecruiterReview,
  mergeExtractionIntoReview,
} from '../lib/talent-intake/talent-intake-review.js';

// ATS-QA-1 I-3 — the backend-owned field authority (Durable-Async I7 / §8.5):
// per-array recruiter origin, extraction never clobbers a recruiter edit, a save
// never wipes extracted evidence, and nothing disappears on a partial, repeated
// or failed extraction. Plus the A2 key_skills union and the rejected-entry
// warning text.

const WH_A = [{ employer_name: 'Initech', role_title: 'Analyst', source_refs: ['B002'] }];
const WH_B = [{ employer_name: 'Globex', role_title: 'Engineer', source_refs: ['B005'] }];
const ED_A = [{ institution_name: 'State University', degree_name: 'BSc', source_refs: ['B009'] }];
const CERT_A = [{ certification_name: 'PMP', source_refs: ['B010'] }];

function result(over: Partial<DraftFromResumeResponse> = {}): DraftFromResumeResponse {
  return {
    prefill: { first_name: 'Ada', last_name: 'Lovelace' },
    parse_status: 'parsed',
    extraction_status: 'success',
    source_map_version: 'resume-source-map/v1',
    resume_text_hash: 'h1',
    ...over,
  } as DraftFromResumeResponse;
}

describe('mergeExtractionIntoReview — per-array authority', () => {
  it('first extraction fills every array and records RESUME_EXTRACTION origin', () => {
    const m = mergeExtractionIntoReview(null, result({ work_history: WH_A, education: ED_A, certifications: CERT_A }));
    expect(m.work_history).toEqual(WH_A);
    expect(m.education).toEqual(ED_A);
    expect(m.certifications).toEqual(CERT_A);
    expect(m.array_origin).toEqual({
      work_history: 'RESUME_EXTRACTION',
      education: 'RESUME_EXTRACTION',
      certifications: 'RESUME_EXTRACTION',
    });
  });

  it('a scalar-only save (no arrays) no longer blocks a later extraction from filling the arrays', () => {
    const saved = applyRecruiterReview(null, {
      fields: { title: { value: 'Lead', origin: 'RECRUITER' } },
    });
    const m = mergeExtractionIntoReview(saved, result({ work_history: WH_A, education: ED_A }));
    expect(m.work_history).toEqual(WH_A);
    expect(m.education).toEqual(ED_A);
    expect(m.fields['title']).toEqual({ value: 'Lead', origin: 'RECRUITER' });
  });

  it('a recruiter-edited work history survives re-extraction; the untouched education is refreshed', () => {
    const first = mergeExtractionIntoReview(null, result({ work_history: WH_A, education: ED_A }));
    const edited = applyRecruiterReview(first, {
      fields: {},
      work_history: [{ employer_name: 'Initech', role_title: 'Senior Analyst' }],
    });
    const ED_B = [{ institution_name: 'Tech Institute', degree_name: 'MSc', source_refs: ['B011'] }];
    const again = mergeExtractionIntoReview(edited, result({ work_history: WH_B, education: ED_B }));
    expect(again.work_history).toEqual([{ employer_name: 'Initech', role_title: 'Senior Analyst' }]);
    expect(again.array_origin?.work_history).toBe('RECRUITER');
    expect(again.education).toEqual(ED_B);
  });

  it('a recruiter who deleted every role keeps the empty list (an explicit decision)', () => {
    const first = mergeExtractionIntoReview(null, result({ work_history: WH_A }));
    const cleared = applyRecruiterReview(first, { fields: {}, work_history: [] });
    const again = mergeExtractionIntoReview(cleared, result({ work_history: WH_B }));
    expect(again.work_history).toEqual([]);
  });

  it('partial / failed / repeated extraction with no entries never removes what the draft holds', () => {
    const first = mergeExtractionIntoReview(null, result({ work_history: WH_A, education: ED_A, skills: [{ surface_form: 'Java', source_refs: ['B1'] }] }));
    const empty = mergeExtractionIntoReview(first, result({ prefill: {}, parse_status: 'partial', extraction_status: 'partial' }));
    expect(empty.work_history).toEqual(WH_A);
    expect(empty.education).toEqual(ED_A);
    expect(empty.skills).toEqual([{ surface_form: 'Java', source_refs: ['B1'] }]);
    expect(empty.resume_provenance?.resume_text_hash).toBe('h1');
  });

  it('a recruiter-edited scalar is never overwritten; an extraction scalar is refreshed', () => {
    const first = mergeExtractionIntoReview(null, result());
    const edited = applyRecruiterReview(first, {
      fields: { first_name: { value: 'Augusta', origin: 'RECRUITER' } },
    });
    const again = mergeExtractionIntoReview(edited, result({ prefill: { first_name: 'A.', last_name: 'King' } }));
    expect(again.fields['first_name']).toEqual({ value: 'Augusta', origin: 'RECRUITER' });
    expect(again.fields['last_name']).toEqual({ value: 'King', origin: 'RESUME_EXTRACTION' });
  });

  it('legacy draft (no array_origin): a non-empty array is kept, an empty one is filled', () => {
    const legacy = { fields: {}, work_history: WH_A, education: [], certifications: [] };
    const m = mergeExtractionIntoReview(legacy, result({ work_history: WH_B, education: ED_A }));
    expect(m.work_history).toEqual(WH_A);
    expect(m.education).toEqual(ED_A);
  });
});

describe('applyRecruiterReview — a save never wipes extracted evidence', () => {
  const extracted = () =>
    mergeExtractionIntoReview(null, result({ work_history: WH_A, education: ED_A, certifications: CERT_A, skills: [{ surface_form: 'Go', source_refs: ['B3'] }] }));

  it('omitted arrays keep the persisted value + origin; skills and provenance are backend-owned', () => {
    const saved = applyRecruiterReview(extracted(), {
      fields: { notes: { value: 'call Tue', origin: 'RECRUITER' } },
      skills: [],
      resume_provenance: { resume_text_hash: 'forged' },
    });
    expect(saved.work_history).toEqual(WH_A);
    expect(saved.education).toEqual(ED_A);
    expect(saved.certifications).toEqual(CERT_A);
    expect(saved.skills).toEqual([{ surface_form: 'Go', source_refs: ['B3'] }]);
    expect(saved.resume_provenance?.resume_text_hash).toBe('h1');
    expect(saved.array_origin?.work_history).toBe('RESUME_EXTRACTION');
    expect(saved.fields['notes']).toEqual({ value: 'call Tue', origin: 'RECRUITER' });
  });

  it('a stale extraction value from the client never rolls back the persisted one', () => {
    const saved = applyRecruiterReview(extracted(), {
      fields: { first_name: { value: 'Old', origin: 'RESUME_EXTRACTION' } },
    });
    expect(saved.fields['first_name']).toEqual({ value: 'Ada', origin: 'RESUME_EXTRACTION' });
  });

  it('a sent array becomes recruiter-owned', () => {
    const saved = applyRecruiterReview(extracted(), { fields: {}, work_history: WH_B });
    expect(saved.work_history).toEqual(WH_B);
    expect(saved.array_origin?.work_history).toBe('RECRUITER');
    expect(saved.array_origin?.education).toBe('RESUME_EXTRACTION');
  });
});

describe('composeKeySkills (row A2) and the rejected-entry warning', () => {
  it('listed first, then evidenced; de-duplicated case-insensitively; first written form wins', () => {
    expect(
      composeKeySkills({
        skills: [
          { surface_form: 'Java', source_refs: ['B1'] },
          { surface_form: 'Kubernetes', source_refs: ['B2'] },
        ],
        work_history: [
          {
            employer_name: 'X',
            role_title: 'Y',
            source_refs: ['B3'],
            skill_usage: [
              { surface_form: 'kubernetes', source_refs: ['B3'] },
              { surface_form: 'Terraform', source_refs: ['B3'] },
              { surface_form: ' Java ', source_refs: ['B3'] },
            ],
          },
        ],
      }),
    ).toBe('Java, Kubernetes, Terraform');
  });

  it('empty when nothing is listed or evidenced', () => {
    expect(composeKeySkills({ skills: [], work_history: [] })).toBe('');
  });

  it('the warning names only grounded employers and counts every rejected entry', () => {
    expect(rejectedWorkHistoryWarning([])).toBeNull();
    expect(rejectedWorkHistoryWarning([{ employer_name: 'Contoso', reason: 'title_not_found' }])).toBe(
      '1 work history entry couldn’t be matched to the resume text and was left out (Contoso). Check the resume and add it below if needed.',
    );
    expect(
      rejectedWorkHistoryWarning([{ reason: 'employer_not_found' }, { reason: 'incomplete_entry' }]),
    ).toBe(
      '2 work history entries couldn’t be matched to the resume text and were left out. Check the resume and add them below if needed.',
    );
  });
});
