import { describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '@aramo/auth';

import { TalentRecordController } from '../lib/talent-record.controller.js';

// TALENT-INTEL-1 TI-1H §9 — GET :id/resume-editions/:editionId/text: the redacted
// text belonging to ONE edition (preview). Reading edition R returns R's own
// text; 404 when the talent is not in the tenant OR the edition is not the
// talent's; only redacted text is exposed (D4). Plus the §6/§17 proof that
// changing the default résumé never writes/deletes résumé text.

const TENANT = '11111111-1111-7111-8111-111111111111';
const TALENT = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const ED_A = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeee1';
const ED_B = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeee2';
const AUTH = { sub: 'me', tenant_id: TENANT, scopes: ['talent:read', 'talent:edit'] } as unknown as AuthContextType;

function make(parts: {
  view?: unknown;
  editions?: Array<{ id: string }>;
  text?: { redacted_text: string | null; status: string; extracted_at: Date | null } | null;
} = {}) {
  const findById = vi.fn().mockResolvedValue(parts.view === undefined ? { id: TALENT } : parts.view);
  const findResumeEditionText = vi.fn().mockResolvedValue(
    parts.text === undefined
      ? { redacted_text: 'edition A redacted body', status: 'extracted', extracted_at: new Date('2026-07-01T00:00:00.000Z') }
      : parts.text,
  );
  const repo = { findById, findResumeEditionText };
  const listResumeEditionsWithDocument = vi.fn().mockResolvedValue(parts.editions ?? [{ id: ED_A }, { id: ED_B }]);
  const setDefaultResumeEdition = vi.fn().mockResolvedValue({});
  const findResumeEditionById = vi.fn().mockResolvedValue({ id: ED_B, tenant_id: TENANT, talent_id: TALENT });
  const talentExtraction = { listResumeEditionsWithDocument, setDefaultResumeEdition, findResumeEditionById };
  const enqueueReindex = vi.fn().mockResolvedValue(undefined);
  const resumeText = { enqueueReindex };

  const ctl = new TalentRecordController(
    repo as never, {} as never, {} as never, {} as never,
    talentExtraction as never, {} as never, {} as never,
    undefined, {} as never, {} as never, resumeText as never,
  );
  return { ctl, findById, findResumeEditionText, listResumeEditionsWithDocument, enqueueReindex, setDefaultResumeEdition };
}

describe('TI-1H §9 — GET :id/resume-editions/:editionId/text', () => {
  it("returns 200 with the requested edition's own redacted text", async () => {
    const { ctl, findResumeEditionText } = make();
    const res = await ctl.getResumeEditionText(AUTH, TALENT, ED_A, 'rq-1');
    expect(res.talent_id).toBe(TALENT);
    expect(res.edition_id).toBe(ED_A);
    expect(res.status).toBe('extracted');
    expect(res.redacted_text).toBe('edition A redacted body');
    expect(res.extracted_at).toBe('2026-07-01T00:00:00.000Z');
    // The read is scoped to the requested edition — never "the talent's résumé".
    expect(findResumeEditionText).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: TENANT, talent_record_id: TALENT, resume_edition_id: ED_A }),
    );
  });

  it('reports status=pending with null text when the edition has no text row yet', async () => {
    const { ctl } = make({ text: null });
    const res = await ctl.getResumeEditionText(AUTH, TALENT, ED_A, 'rq-1');
    expect(res.status).toBe('pending');
    expect(res.redacted_text).toBeNull();
    expect(res.extracted_at).toBeNull();
  });

  it('404 when the talent is not in the tenant (no text read attempted)', async () => {
    const { ctl, findResumeEditionText } = make({ view: null });
    await expect(ctl.getResumeEditionText(AUTH, 'missing', ED_A, 'rq-1')).rejects.toMatchObject({ statusCode: 404 });
    expect(findResumeEditionText).not.toHaveBeenCalled();
  });

  it('404 when the edition does not belong to the talent (never a cross-edition read)', async () => {
    const { ctl, findResumeEditionText } = make({ editions: [{ id: ED_A }] });
    await expect(ctl.getResumeEditionText(AUTH, TALENT, ED_B, 'rq-1')).rejects.toMatchObject({ statusCode: 404 });
    expect(findResumeEditionText).not.toHaveBeenCalled();
  });
});

describe('TI-1H §6 — changing the default résumé never writes/deletes résumé text', () => {
  it('the default-set path does not touch the résumé-text writer', async () => {
    // Full projected rows so the response mapper (toResumeEditionView) is satisfied.
    const fullRow = (id: string) => ({
      id, tenant_id: TENANT, talent_id: TALENT, talent_document_id: `doc-${id}`, attachment_id: null,
      purpose: 'GENERAL', label: null, lifecycle_status: 'active',
      created_at: new Date('2026-07-01T00:00:00.000Z'), document_filename: 'r.pdf',
      document_mime_type: 'application/pdf', document_uploaded_at: new Date('2026-07-01T00:00:00.000Z'),
      is_default: id === ED_B, processing_status: null,
    });
    const { ctl, enqueueReindex, setDefaultResumeEdition } = make({ editions: [fullRow(ED_A), fullRow(ED_B)] as never });
    await ctl.setDefaultResumeEdition(AUTH, TALENT, { resume_edition_id: ED_B } as never, 'rq-1');
    expect(setDefaultResumeEdition).toHaveBeenCalled();
    expect(enqueueReindex).not.toHaveBeenCalled();
  });
});
