import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DocumentsSection } from './t360-documents';
import type { Talent360View as Model } from './talent-360-types';

// ATS-QA-1 I-1 UX — résumé version rows show their revision ordinal ("Revision N").

const tal = vi.hoisted(() => ({
  createAttachment: vi.fn(),
  createTalentResumeEdition: vi.fn(),
  getAttachmentDownloadUrl: vi.fn(),
  listTalentAttachments: vi.fn(),
  listTalentResumeEditions: vi.fn(),
  requestResumeUploadUrl: vi.fn(),
  setTalentResumeEditionDefault: vi.fn(),
}));
vi.mock('../talent/talent-api', () => ({ ...tal }));
vi.mock('../users/users-api', () => ({ resolveUserNames: vi.fn().mockResolvedValue({}) }));
vi.mock('./talent-360-api', () => ({ getTalent360DocumentContent: vi.fn() }));

const BASE = {
  talent_document_id: 'td',
  attachment_id: null,
  label: null,
  lifecycle_status: 'active',
  created_at: '2026-09-14T00:00:00Z',
  mime_type: 'application/pdf',
  client_context_id: null,
  derived_from_edition_id: null,
  processing_status: null,
  purpose: 'GENERAL',
  requisition_id: null,
};

const MODEL = { documents: { total: 0, key_documents: [] }, opportunities: null } as unknown as Model;

describe('DocumentsSection — résumé revision numbers (ATS-QA-1 UX)', () => {
  beforeEach(() => {
    tal.listTalentAttachments.mockResolvedValue({ items: [] });
  });

  it('each résumé row shows "Revision N"; an un-numbered edition shows none', async () => {
    tal.listTalentResumeEditions.mockResolvedValue({
      editions: [
        { ...BASE, edition_id: 'ed-3', filename: 'cv_v3.pdf', uploaded_at: '2026-09-20T00:00:00Z', is_default: true, revision_number: 3 },
        { ...BASE, edition_id: 'ed-2', filename: 'cv_v2.pdf', uploaded_at: '2026-08-20T00:00:00Z', is_default: false, revision_number: 2 },
        { ...BASE, edition_id: 'ed-x', filename: 'cv_legacy.pdf', uploaded_at: '2025-01-01T00:00:00Z', is_default: false, revision_number: null },
      ],
    });
    render(<DocumentsSection model={MODEL} talentId="tal-1" canEdit={false} />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Preview Resume/ })).toHaveLength(3));
    const [r3, r2, legacy] = screen.getAllByRole('button', { name: /^Preview Resume/ }) as [HTMLElement, HTMLElement, HTMLElement];
    expect(within(r3).getByText('Revision 3')).toBeInTheDocument();
    expect(within(r2).getByText('Revision 2')).toBeInTheDocument();
    expect(within(legacy).queryByText(/Revision/)).toBeNull();
    // The accessible name is unchanged (the revision is visual context on the row).
    expect(r3.getAttribute('aria-label')).toBe('Preview Resume');
  });
});
