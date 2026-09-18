import { describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '@aramo/auth';

import { PipelineController } from '../lib/pipeline.controller.js';

// TALENT-INTEL-1 TI-1D-D — the Pipeline résumé-edition routes (GET state / PUT
// explicit select). The default is a suggestion only; selection is explicit +
// append-only; new selection requires an ACTIVE edition of THIS talent.

const TENANT = '11111111-1111-7111-8111-111111111111';
const TALENT = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const REQ = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const AUTH = { sub: 'me', tenant_id: TENANT, scopes: ['pipeline:read', 'pipeline:resume:set'] } as unknown as AuthContextType;

function edition(id: string, over: Record<string, unknown> = {}) {
  return {
    edition_id: id,
    lifecycle_status: 'active',
    is_default: false,
    purpose: 'GENERAL',
    label: null,
    filename: 'r.pdf',
    mime_type: 'application/pdf',
    created_at: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

function make(parts: {
  view?: unknown;
  editions?: unknown[];
  current?: unknown;
} = {}) {
  const findByIdForActor = vi.fn().mockResolvedValue(
    parts.view === undefined ? { id: 'pl-1', talent_record_id: TALENT, requisition_id: REQ } : parts.view,
  );
  const getCurrentRequisitionResume = vi.fn().mockResolvedValue(parts.current ?? null);
  const createRequisitionResumeSelection = vi.fn().mockResolvedValue({ id: 'sel-1' });
  const pipelineRepository = { findByIdForActor, getCurrentRequisitionResume, createRequisitionResumeSelection };
  const listResumeEditions = vi.fn().mockResolvedValue(parts.editions ?? [edition('ed-a', { is_default: true }), edition('ed-b')]);
  const editionReader = { listResumeEditions };
  const ctl = new PipelineController(
    pipelineRepository as never,
    {} as never,
    {} as never,
    editionReader as never,
  );
  const req = { resolveVisibleRequisitionIds: async () => [REQ] } as never;
  return { ctl, req, findByIdForActor, getCurrentRequisitionResume, createRequisitionResumeSelection, listResumeEditions };
}

describe('TI-1D-D — GET /v1/pipelines/:id/resume-edition', () => {
  it('returns selection + default suggestion + active-available editions', async () => {
    const { ctl, req } = make({
      current: { resume_edition_id: 'ed-b', selected_at: new Date('2026-07-05T00:00:00.000Z'), selected_by: 'me' },
      editions: [edition('ed-a', { is_default: true }), edition('ed-b'), edition('ed-c', { lifecycle_status: 'archived' })],
    });
    const res = await ctl.getResumeEdition(AUTH, 'pl-1', 'rq-1', req);
    expect(res.selected_edition_id).toBe('ed-b'); // the explicit selection
    expect(res.default_edition_id).toBe('ed-a'); // suggestion only
    // archived edition is NOT offered for new selection
    expect(res.available_editions.map((e) => e.edition_id)).toEqual(['ed-a', 'ed-b']);
    expect(res.talent_record_id).toBe(TALENT);
  });

  it('404 when the pipeline is not visible to the actor', async () => {
    const { ctl, req } = make({ view: null });
    await expect(ctl.getResumeEdition(AUTH, 'missing', 'rq-1', req)).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
  });
});

describe('TI-1D-D — PUT /v1/pipelines/:id/resume-edition', () => {
  it('selects an ACTIVE edition of this talent → appends a selection row', async () => {
    const { ctl, req, createRequisitionResumeSelection } = make({
      current: { resume_edition_id: 'ed-b', selected_at: new Date('2026-07-05T00:00:00.000Z'), selected_by: 'me' },
    });
    await ctl.setResumeEdition(AUTH, 'pl-1', { resume_edition_id: 'ed-b', note: 'client fit' } as never, 'rq-1', req);
    expect(createRequisitionResumeSelection).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: TENANT, talent_record_id: TALENT, requisition_id: REQ, resume_edition_id: 'ed-b', selected_by: 'me', note: 'client fit' }),
    );
  });

  it('404 when the edition does not belong to this talent', async () => {
    const { ctl, req, createRequisitionResumeSelection } = make();
    await expect(ctl.setResumeEdition(AUTH, 'pl-1', { resume_edition_id: 'ed-foreign' } as never, 'rq-1', req)).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    expect(createRequisitionResumeSelection).not.toHaveBeenCalled();
  });

  it('422 when the edition is not active (archived/retracted cannot be newly selected)', async () => {
    const { ctl, req, createRequisitionResumeSelection } = make({
      editions: [edition('ed-x', { lifecycle_status: 'retracted' })],
    });
    await expect(ctl.setResumeEdition(AUTH, 'pl-1', { resume_edition_id: 'ed-x' } as never, 'rq-1', req)).rejects.toMatchObject({ statusCode: 422 });
    expect(createRequisitionResumeSelection).not.toHaveBeenCalled();
  });
});
