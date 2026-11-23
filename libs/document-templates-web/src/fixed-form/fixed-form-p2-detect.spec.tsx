import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { type LoadedPdf } from '../pdf';

import { FixedFormStudio, type FixedFormStudioDataSource, type FixedFormStudioTemplate } from './FixedFormStudio';
import { bytesToBase64, type FixedFormVersionView } from './fixed-form-model';

// FIELD-PARITY-1 §5 P2-4 / P2-5 / P2-6 — the console form Studio host: "Find fields" asks the
// fixed-form suggestions route and accepted ghosts are saved as ordinary fields; the upload
// options send a flag only when ticked; the import result is shown in plain language.

const fakeLoad = vi.fn(async (): Promise<LoadedPdf> => ({ pages: [{ width: 612, height: 792 }], render: async () => undefined, destroy: () => undefined }));

const TEMPLATE: FixedFormStudioTemplate = {
  id: 't1',
  name: 'Minutes',
  description: null,
  status: 'DRAFT',
  products: ['sign'],
  document_type_id: 'type-min',
  current_version: null,
  draft_version_id: 'v1',
  withdraw_effective_at: null,
};

function view(over: Partial<FixedFormVersionView> = {}): FixedFormVersionView {
  return {
    template_id: 't1',
    version_id: 'v1',
    version_number: 1,
    status: 'DRAFT',
    content: {
      render_schema_version: 'fixed-form-pdf-v1',
      title: 'Minutes',
      pdf: { asset_id: 'a1', sha256: 'f'.repeat(64), byte_size: 2048, page_count: 1, pages: [{ width: 612, height: 792 }] },
      signing: { roles: [{ role_key: 'chair', label: 'Chair', kind: 'SIGNER', order: 1 }], routing_mode: 'PARALLEL' },
    },
    fields: [],
    variables: [],
    issues: [],
    previewed: false,
    sender_filled_fields_enabled: false,
    ...over,
  };
}

function source(over: Partial<FixedFormStudioDataSource> = {}): FixedFormStudioDataSource {
  return {
    loadTemplate: vi.fn(async () => TEMPLATE),
    typeProducts: vi.fn(async () => ['sign' as const]),
    view: vi.fn(async () => view()),
    pdf: vi.fn(async () => ({ content_base64: bytesToBase64(new TextEncoder().encode('%PDF-1.7').buffer) })),
    createDraft: vi.fn(async () => view()),
    uploadPdf: vi.fn(async () => view()),
    saveLayout: vi.fn(async (_v, body) => view({ fields: [...body.fields] })),
    preview: vi.fn(async () => view({ previewed: true })),
    publish: vi.fn(async () => undefined),
    fieldSuggestions: vi.fn(async () => ({
      suggestions: [
        { type: 'SIGNATURE', page: 1, page_number: 0, x: 72, y: 100, width: 230, height: 50, reason: 'label:Signature', confidence: 0.95 },
        { type: 'TEXT', page: 1, page_number: 0, x: 72, y: 400, width: 300, height: 80, reason: 'empty_box', confidence: 0.6 },
      ],
      skipped_pages: [],
    })),
    ...over,
  };
}

const pdfFile = () => new File([new Uint8Array([37, 80, 68, 70])], 'form.pdf', { type: 'application/pdf' });

describe('FIELD-PARITY-1 P2-4 — Find fields in the console Studio', () => {
  it('fetches the version’s suggestions; Accept all adds both as ONE undo step, for the selected role, and saves them', async () => {
    const ds = source();
    render(<FixedFormStudio dataSource={ds} templateId="t1" canManage loadPdfFn={fakeLoad} />);
    await screen.findByTestId('ffs-page-0');
    await act(async () => {
      fireEvent.click(screen.getByTestId('ffs-find-fields'));
    });
    expect(ds.fieldSuggestions).toHaveBeenCalledWith('v1');
    expect(screen.getByTestId('ffs-ghost-form:0')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ffs-accept-all'));
    expect(screen.getByTestId('ffs-field-signature_1')).toBeInTheDocument();
    expect(screen.getByTestId('ffs-field-text_1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(ds.saveLayout).toHaveBeenCalled());
    const body = (ds.saveLayout as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as { fields: Array<Record<string, unknown>> };
    expect(body.fields).toEqual([
      expect.objectContaining({ field_key: 'signature_1', field_type: 'SIGNATURE', signer_role: 'chair', x: 72, y: 100, width: 230, height: 50, required: true }),
      expect.objectContaining({ field_key: 'text_1', field_type: 'TEXT', signer_role: 'chair', x: 72, y: 400, width: 300, height: 80, required: false }),
    ]);
  });

  it('no Find fields without a PDF, or when the form is read-only', async () => {
    const ds = source({ view: vi.fn(async () => view({ content: { ...view().content, pdf: null } })) });
    const r = render(<FixedFormStudio dataSource={ds} templateId="t1" canManage loadPdfFn={fakeLoad} />);
    await screen.findByText('No PDF uploaded.');
    expect(screen.queryByTestId('ffs-find-fields')).toBeNull();
    r.unmount();
    render(<FixedFormStudio dataSource={source()} templateId="t1" canManage={false} loadPdfFn={fakeLoad} />);
    await screen.findByTestId('ffs-page-0');
    expect(screen.queryByTestId('ffs-find-fields')).toBeNull();
  });
});

describe('FIELD-PARITY-1 P2-5 / P2-6 — upload options in the console Studio', () => {
  it('without the options the upload sends no flag', async () => {
    const ds = source();
    render(<FixedFormStudio dataSource={ds} templateId="t1" canManage loadPdfFn={fakeLoad} />);
    await screen.findByTestId('ffs-page-0');
    expect((screen.getByTestId('ffs-opt-import_fields') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId('ffs-opt-apply_text_tags') as HTMLInputElement).checked).toBe(false);
    fireEvent.change(screen.getByTestId('ffs-upload-input'), { target: { files: [pdfFile()] } });
    await waitFor(() => expect(ds.uploadPdf).toHaveBeenCalled());
    expect((ds.uploadPdf as ReturnType<typeof vi.fn>).mock.calls[0]).toHaveLength(2);
    expect(screen.queryByTestId('ffs-import-result')).toBeNull();
  });

  it('ticked options are sent, and the result shows the count, each warning in plain language and what was removed', async () => {
    const result = view({
      field_import: {
        fields: [{ field_key: 'signature_chair', field_type: 'SIGNATURE', binding_key: null, signer_role: 'chair', required: true, page_number: 0, x: 1, y: 1, width: 100, height: 20, ordinal: 0, source: 'text_tag', source_name: 'signature:Chair' }],
        warnings: [{ code: 'text_tag_type_unknown', message: 'server', name: 'stamp:Chair', page_number: 0 }],
        stripped: ['/AcroForm'],
      },
    });
    const ds = source({ uploadPdf: vi.fn(async () => result) });
    render(<FixedFormStudio dataSource={ds} templateId="t1" canManage loadPdfFn={fakeLoad} />);
    await screen.findByTestId('ffs-page-0');
    fireEvent.click(screen.getByTestId('ffs-opt-import_fields'));
    fireEvent.click(screen.getByTestId('ffs-opt-apply_text_tags'));
    fireEvent.change(screen.getByTestId('ffs-upload-input'), { target: { files: [pdfFile()] } });
    await waitFor(() => expect(ds.uploadPdf).toHaveBeenCalled());
    expect((ds.uploadPdf as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toEqual({ import_fields: true, apply_text_tags: true });
    expect(await screen.findByTestId('ffs-import-summary')).toHaveTextContent('1 field added · 1 warning · active content removed');
    expect(screen.getByTestId('ffs-import-warnings')).toHaveTextContent('A tag names a field type we don’t know, so it was left as text. (stamp:Chair, page 1)');
    expect(screen.getByTestId('ffs-import-stripped')).toHaveTextContent('/AcroForm');
    fireEvent.click(screen.getByTestId('ffs-import-close'));
    expect(screen.queryByTestId('ffs-import-result')).toBeNull();
  });

  it('only the ticked option is sent', async () => {
    const ds = source();
    render(<FixedFormStudio dataSource={ds} templateId="t1" canManage loadPdfFn={fakeLoad} />);
    await screen.findByTestId('ffs-page-0');
    fireEvent.click(screen.getByTestId('ffs-opt-apply_text_tags'));
    fireEvent.change(screen.getByTestId('ffs-upload-input'), { target: { files: [pdfFile()] } });
    await waitFor(() => expect(ds.uploadPdf).toHaveBeenCalled());
    expect((ds.uploadPdf as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toEqual({ apply_text_tags: true });
  });
});
