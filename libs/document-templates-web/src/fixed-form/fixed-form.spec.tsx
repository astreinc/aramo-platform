import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { clampBox, toPdf, toTopLeft, type LoadedPdf } from '../pdf';

import { FixedFormStudio, type FixedFormStudioDataSource, type FixedFormStudioTemplate } from './FixedFormStudio';
import { FixedFormPreview } from './FixedFormPreview';
import { base64ToBytes, bytesToBase64, nextFieldKey, roleKeyFromLabel, type FixedFormVersionView } from './fixed-form-model';

// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) §7.2 / §7.3 — the Platform Studio's
// fixed-form mode and the tenant read-only preview. pdf.js does not run under jsdom: a fake
// loader reports the pages.

const fakeLoad = vi.fn(
  async (): Promise<LoadedPdf> => ({
    pages: [{ width: 612, height: 792 }],
    render: async () => undefined,
    destroy: () => undefined,
  }),
);

const TEMPLATE: FixedFormStudioTemplate = {
  id: 't1',
  name: 'Form I-9',
  description: null,
  status: 'DRAFT',
  products: ['sign'],
  document_type_id: 'type-i9',
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
      title: 'Form I-9',
      pdf: { asset_id: 'a1', sha256: 'f'.repeat(64), byte_size: 2048, page_count: 1, pages: [{ width: 612, height: 792 }] },
      signing: { roles: [{ role_key: 'employee', label: 'Employee', kind: 'SIGNER', order: 1 }], routing_mode: 'PARALLEL' },
    },
    fields: [],
    variables: [{ key: 'organization.name', label: 'Organization name', group: 'Org', data_type: 'TEXT', sample_value: null }],
    issues: [{ code: 'fields_required', message: 'Place at least one field.' }],
    previewed: false,
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
    saveLayout: vi.fn(async (_v, body) => view({ fields: [...body.fields], issues: [] })),
    preview: vi.fn(async () => view({ issues: [], previewed: true })),
    publish: vi.fn(async () => undefined),
    ...over,
  };
}

describe('fixed-form model helpers', () => {
  it('keys, base64 round trip and the shared geometry', () => {
    expect(roleKeyFromLabel('Employer Rep', new Set(['employer_rep']))).toBe('employer_rep_2');
    expect(nextFieldKey('SIGNATURE', [{ field_key: 'signature_1' }])).toBe('signature_2');
    const bytes = new Uint8Array([0, 1, 2, 250, 255]).buffer;
    expect(new Uint8Array(base64ToBytes(bytesToBase64(bytes)))).toEqual(new Uint8Array(bytes));
    const box = { x: 10, y: 20, width: 100, height: 30 };
    expect(toPdf(toTopLeft(box, 792), 792)).toEqual(box);
    expect(clampBox({ x: 600, y: -5, width: 100, height: 30 }, { width: 612, height: 792 })).toEqual({ x: 512, y: 0, width: 100, height: 30 });
  });
});

describe('FixedFormStudio (§7.2)', () => {
  it('places a field for the chosen role, saves the layout, checks, then publishes', async () => {
    const ds = source();
    render(<FixedFormStudio dataSource={ds} templateId="t1" canManage loadPdfFn={fakeLoad} />);
    expect(await screen.findByText('Form I-9')).toBeInTheDocument();
    expect(await screen.findByTestId('ffs-page-0')).toBeInTheDocument();
    expect(screen.getByText('Place at least one field.')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ffs-add-SIGNATURE'));
    expect(screen.getByTestId('ffs-field-signature_1')).toBeInTheDocument();
    expect(screen.getByTestId('ffs-inspector')).toHaveTextContent('signature_1');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(ds.saveLayout).toHaveBeenCalledTimes(1));
    const body = (ds.saveLayout as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { fields: Array<Record<string, unknown>>; signing: { roles: unknown[] } };
    expect(body.fields).toEqual([expect.objectContaining({ field_key: 'signature_1', field_type: 'SIGNATURE', signer_role: 'employee', page_number: 0, binding_key: null })]);
    expect(body.signing.roles).toHaveLength(1);

    const publish = screen.getByRole('button', { name: 'Publish' });
    expect(publish).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    await waitFor(() => expect(ds.preview).toHaveBeenCalledWith('v1'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Publish' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(ds.publish).toHaveBeenCalledWith('v1'));
  });

  it('a text field may instead be prefilled by a variable', async () => {
    const ds = source();
    render(<FixedFormStudio dataSource={ds} templateId="t1" canManage loadPdfFn={fakeLoad} />);
    await screen.findByTestId('ffs-page-0');
    fireEvent.click(screen.getByTestId('ffs-add-TEXT'));
    fireEvent.change(screen.getByLabelText('Filled by'), { target: { value: 'var:organization.name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(ds.saveLayout).toHaveBeenCalled());
    const body = (ds.saveLayout as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { fields: Array<Record<string, unknown>> };
    expect(body.fields[0]).toMatchObject({ field_type: 'TEXT', binding_key: 'organization.name', signer_role: null });
  });

  it('shows the server issues when the check refuses', async () => {
    const err = Object.assign(new Error('This form is not ready to publish'), { details: { reason: 'fixed_form_incomplete', issues: [{ code: 'role_without_signature', message: 'Signer role employee has no signature field.' }] } });
    const ds = source({ view: vi.fn(async () => view({ issues: [] })), preview: vi.fn(async () => Promise.reject(err)) });
    render(<FixedFormStudio dataSource={ds} templateId="t1" canManage loadPdfFn={fakeLoad} />);
    await screen.findByTestId('ffs-page-0');
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByText('Signer role employee has no signature field.')).toBeInTheDocument();
  });

  it('read-only without manage: no editing controls', async () => {
    render(<FixedFormStudio dataSource={source()} templateId="t1" canManage={false} loadPdfFn={fakeLoad} />);
    await screen.findByTestId('ffs-page-0');
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByTestId('ffs-add-SIGNATURE')).toBeNull();
    expect(screen.queryByRole('button', { name: /Upload PDF/ })).toBeNull();
  });

  it('a template with no version offers to start the first one', async () => {
    const ds = source({ loadTemplate: vi.fn(async () => ({ ...TEMPLATE, draft_version_id: null })) });
    render(<FixedFormStudio dataSource={ds} templateId="t1" canManage loadPdfFn={fakeLoad} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start the first version' }));
    await waitFor(() => expect(ds.createDraft).toHaveBeenCalledWith('t1'));
  });
});

describe('FixedFormPreview (§7.3)', () => {
  it('renders the form read-only with its roles and prefilled variables', async () => {
    const detail = {
      id: 't1',
      name: 'Form I-9',
      description: null,
      document_type: { id: 'type-i9', key: 'I9', name: 'Form I-9', category: 'Employment' },
      products: ['sign'],
      version_id: 'v1',
      version_number: 2,
      updated_at: '2026-11-02T00:00:00.000Z',
      withdraw_effective_at: null,
      page_count: 1,
      hidden: false,
      title: 'Form I-9',
      pages: [{ width: 612, height: 792 }],
      signing: view().content.signing,
      fields: [
        { field_key: 'sig', field_type: 'SIGNATURE', binding_key: null, signer_role: 'employee', required: true, page_number: 0, x: 72, y: 72, width: 160, height: 32, ordinal: 0 },
        { field_key: 'org', field_type: 'TEXT', binding_key: 'organization.name', signer_role: null, required: true, page_number: 0, x: 72, y: 600, width: 160, height: 18, ordinal: 1 },
      ],
      variables: [{ key: 'organization.name', label: 'Organization name' }],
    };
    render(
      <FixedFormPreview
        templateId="t1"
        detailFn={vi.fn(async () => detail)}
        pdfFn={vi.fn(async () => ({ sha256: 'x', byte_size: 8, content_base64: bytesToBase64(new TextEncoder().encode('%PDF-1.7').buffer) }))}
        loadPdfFn={fakeLoad}
      />,
    );
    expect(await screen.findByText(/Aramo form · read-only · v2/)).toBeInTheDocument();
    expect(screen.getByText(/Signed by: Employee · Prefilled: Organization name/)).toBeInTheDocument();
    expect(await screen.findByTestId('ffs-field-sig')).not.toHaveAttribute('role');
    expect(screen.getByTestId('ffs-field-org')).toHaveTextContent('Prefilled: Organization name');
  });
});
