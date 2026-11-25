import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IdentityProvider } from '../identity/identity';
import { platformSession } from '../skills/test-session';

import { documentTemplatesApi, type PlatformTemplateDetail, type TemplateVersion } from './document-templates-api';
import { PlatformTemplateStudio as TemplateStudio } from './DocumentTemplateDetailView';

// TEMPLATE-FIELDS-1 (Aramo-Template-Fields-1-Directive-v1_0-LOCKED) §5.4 — authoring fields in the
// text in the platform Studio: Insert field at the caret (type, role, settings), the chip, move
// (cut / paste is covered in the codec spec), delete, undo, the content and the rows saved
// together (F-14), and the ATS blocking check (F-17).

const MANAGE = ['platform:tenant:read', 'platform:document_template:read', 'platform:document_template:manage'];
const SIGNING = { roles: [{ role_key: 'employee', label: 'Employee', kind: 'SIGNER', order: 1 }], routing_mode: 'PARALLEL' };

function draft(body: string): TemplateVersion {
  return {
    id: 'd1',
    template_id: 't1',
    version_number: 1,
    status: 'DRAFT',
    render_schema_version: 'rtr-html-v3',
    field_schema: { render_schema_version: 'rtr-html-v3', title: 'Employee Handbook', html: body, signing: SIGNING },
    activated_at: null,
    created_at: '2026-11-01T10:00:00.000Z',
    content_fingerprint: 'fp1',
    previewed_fingerprint: null,
    internal_notes: null,
  };
}

function detail(v: TemplateVersion, products: string[]): PlatformTemplateDetail {
  return {
    id: 't1',
    owner_scope: 'PLATFORM',
    document_type_id: 'dt-rtr',
    name: 'Employee Handbook',
    description: null,
    template_kind: 'GENERATED',
    status: 'DRAFT',
    products,
    current_version: null,
    draft_version_id: v.id,
    withdraw_notice_at: null,
    withdraw_effective_at: null,
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
    versions: [v],
  };
}

function mockApi(d: PlatformTemplateDetail, rows: unknown[] = []) {
  vi.spyOn(documentTemplatesApi, 'getTemplate').mockResolvedValue(d);
  vi.spyOn(documentTemplatesApi, 'allowedBindings').mockResolvedValue({ bindings: [] });
  vi.spyOn(documentTemplatesApi, 'listVariables').mockResolvedValue({ variables: [] });
  vi.spyOn(documentTemplatesApi, 'listDocumentTypes').mockResolvedValue({ document_types: [{ id: 'dt-rtr', key: 'rtr', name: 'Right to represent', configurable: true }] });
  vi.spyOn(documentTemplatesApi, 'listVersionFields').mockResolvedValue({ fields: rows as never, sender_filled_fields_enabled: false });
}

function renderStudio() {
  const session = platformSession(MANAGE);
  return render(
    <MemoryRouter>
      <IdentityProvider session={session} load={() => Promise.reject(new Error('no me'))}>
        <TemplateStudio session={session} templateId="t1" />
      </IdentityProvider>
    </MemoryRouter>,
  );
}

function caretAtEnd(el: HTMLElement): void {
  const sel = window.getSelection();
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  sel?.removeAllRanges();
  sel?.addRange(r);
  document.dispatchEvent(new Event('selectionchange'));
}

beforeEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true, writable: true });
});

describe('Platform Studio — Insert field (TEMPLATE-FIELDS-1 F-14)', () => {
  it('inserts a field at the caret (type, role), shows a chip, and saves the content with its row', async () => {
    mockApi(detail(draft('<p>Signed: </p>'), ['sign']));
    const update = vi.spyOn(documentTemplatesApi, 'updateDraft').mockImplementation(async (_id, body) => ({ ...draft('<p>Signed: </p>'), field_schema: body.field_schema as never }));
    renderStudio();
    const p = await screen.findByRole('textbox', { name: 'Paragraph' });
    caretAtEnd(p);
    fireEvent.mouseDown(screen.getByTestId('insert-field'));
    const dialog = await screen.findByTestId('inline-field-dialog');
    fireEvent.click(within(dialog).getByTestId('inline-field-type-SIGNATURE'));
    // The role picker offers the signer roles; the first is chosen.
    expect((within(dialog).getByTestId('inline-field-role') as HTMLSelectElement).value).toBe('employee');
    fireEvent.click(screen.getByRole('button', { name: 'Insert field' }));
    const chip = await screen.findByTestId('field-chip-signature_1');
    expect(chip.textContent).toContain('Signature · Employee');
    expect(chip.getAttribute('contenteditable')).toBe('false');
    fireEvent.keyDown(document, { key: 's', metaKey: true });
    await waitFor(() => expect(update).toHaveBeenCalled());
    const body = update.mock.calls[0]?.[1] as { field_schema: { html: string; render_schema_version: string }; fields: unknown[] };
    expect(body.field_schema.render_schema_version).toBe('rtr-html-v3');
    expect(body.field_schema.html).toContain('<span data-sign-field="signature_1"></span>');
    expect(body.fields).toEqual([{ field_key: 'signature_1', field_type: 'SIGNATURE', signer_role: 'employee', required: true, ordinal: 0 }]);
  });

  it('a placed field opens its settings; Delete removes the chip and Undo brings it back', async () => {
    const rows = [{ field_key: 'policy_ack', field_type: 'CHECKBOX', signer_role: 'employee', required: false, label: 'IT policy' }];
    mockApi(detail(draft('<p>I accept <span data-sign-field="policy_ack"></span></p>'), ['sign']), rows);
    renderStudio();
    const chip = await screen.findByTestId('field-chip-policy_ack');
    expect(chip.textContent).toContain('IT policy · Employee');
    fireEvent.click(chip);
    const dialog = await screen.findByTestId('inline-field-dialog');
    expect(within(dialog).getByText('Checkbox')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByTestId('inline-field-delete'));
    await waitFor(() => expect(screen.queryByTestId('field-chip-policy_ack')).toBeNull());
    await act(async () => {
      fireEvent.mouseDown(screen.getByRole('button', { name: 'Undo' }));
    });
    expect(await screen.findByTestId('field-chip-policy_ack')).toBeInTheDocument();
  });

  it('F-17 — fields in the text of an ATS-tagged template are a blocking check', async () => {
    const rows = [{ field_key: 'sig', field_type: 'SIGNATURE', signer_role: 'employee', required: true }];
    mockApi(detail(draft('<p>Signed: <span data-sign-field="sig"></span></p>'), ['ats', 'sign']), rows);
    renderStudio();
    await screen.findByTestId('field-chip-sig');
    fireEvent.click(screen.getByRole('tab', { name: /Checks/ }));
    expect(screen.getByText('No fields in the text of an ATS template')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish v1…' })).toHaveAttribute('aria-disabled', 'true');
  });
});
