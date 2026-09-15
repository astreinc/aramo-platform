import { describe, expect, it } from 'vitest';

import { buildCreateBody, emptyIntakeState } from './intake-fields';
import type { WorkHistoryDraft } from './types';

// HF1 §16/R8 — durable source provenance must SURVIVE the FE review state into
// the create request. The governed-LLM draft returns work-history entries
// carrying `source_refs` (source-map block ids); the recruiter reviews them; the
// create body must preserve those refs to the persistence seam (where durable
// column persistence is a filed HALT — see the Gate-6 schema proposal).

describe('buildCreateBody — résumé source_refs survive to the create request', () => {
  it('carries work-history source_refs through unchanged', () => {
    const state = { ...emptyIntakeState(), first_name: 'Sarah', last_name: 'Nolan' };
    const workHistory: WorkHistoryDraft[] = [
      {
        employer_name: 'Northstar Systems',
        role_title: 'Cloud Engineer',
        start_date: '2019',
        source_refs: ['B004', 'B005'],
      },
    ];
    const body = buildCreateBody(state, workHistory) as unknown as {
      work_history?: Array<{ employer_name: string; source_refs?: string[] }>;
    };
    expect(body.work_history).toHaveLength(1);
    expect(body.work_history?.[0]?.source_refs).toEqual(['B004', 'B005']);
    // R4 — no résumé narrative rides along.
    expect(body.work_history?.[0]).not.toHaveProperty('description');
  });

  it('carries structured skills + résumé document provenance into the create body', () => {
    const state = { ...emptyIntakeState(), first_name: 'Sarah', last_name: 'Nolan' };
    const body = buildCreateBody(state, [], {
      skills: [{ surface_form: 'C#', source_refs: ['B003'] }],
      resumeDocument: {
        storage_key: 's3/resume.pdf',
        file_name: 'resume.pdf',
        mime_type: 'application/pdf',
        size_bytes: 42,
        source_map_version: 'resume-source-map/v1',
        resume_text_hash: 'hash-9',
      },
    }) as unknown as {
      skills?: Array<{ surface_form: string; source_refs: string[] }>;
      resume_document?: { storage_key: string; source_map_version?: string };
    };
    expect(body.skills).toEqual([{ surface_form: 'C#', source_refs: ['B003'] }]);
    expect(body.resume_document?.storage_key).toBe('s3/resume.pdf');
    expect(body.resume_document?.source_map_version).toBe('resume-source-map/v1');
  });

  it('still drops entries missing the required employer/role', () => {
    const state = { ...emptyIntakeState(), first_name: 'A', last_name: 'B' };
    const workHistory: WorkHistoryDraft[] = [
      { employer_name: '  ', role_title: 'Orphan', source_refs: ['B001'] },
    ];
    const body = buildCreateBody(state, workHistory) as unknown as {
      work_history?: unknown[];
    };
    expect(body.work_history).toBeUndefined();
  });
});
