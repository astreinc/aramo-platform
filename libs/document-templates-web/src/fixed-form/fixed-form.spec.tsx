import { FIELD_DEFAULTS, fieldTypesFor } from '@aramo/sign-fields';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { clampBox, toPdf, toTopLeft, type LoadedPdf } from '../pdf';

import { FixedFormStudio, type FixedFormStudioDataSource, type FixedFormStudioTemplate } from './FixedFormStudio';
import { FixedFormPreview } from './FixedFormPreview';
import { FIXED_FORM_FIELD_TYPES, base64ToBytes, bytesToBase64, nextFieldKey, roleKeyFromLabel, type FixedFormVersionView } from './fixed-form-model';

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

describe('FIELD-PARITY-1 P1-0 / P1-2 — the palette is the catalog', () => {
  it('offers exactly the template_fixed_form types, in the Studio order, with the catalog sizes and required defaults', () => {
    // FIELD-PARITY-1 P3 (R-1) — the original six first, then the profile types, ACKNOWLEDGEMENT and the new types.
    expect(FIXED_FORM_FIELD_TYPES.map((t) => t.type)).toEqual([
      'SIGNATURE', 'INITIALS', 'SIGNER_NAME', 'SIGN_DATE', 'TEXT', 'CHECKBOX',
      'FIRST_NAME', 'LAST_NAME', 'EMAIL', 'COMPANY', 'TITLE', 'ACKNOWLEDGEMENT', 'DATE', 'DROPDOWN', 'RADIO', 'NUMBER', 'MULTILINE_TEXT',
    ]);
    expect(FIXED_FORM_FIELD_TYPES.map((t) => t.type).sort()).toEqual([...fieldTypesFor('template_fixed_form')].sort());
    expect(FIXED_FORM_FIELD_TYPES.map((t) => t.label).slice(0, 6)).toEqual(['Signature', 'Initials', 'Name', 'Date', 'Text', 'Checkbox']);
    expect(FIXED_FORM_FIELD_TYPES.find((t) => t.type === 'DATE')?.label).toBe('Chosen date');
    for (const t of FIXED_FORM_FIELD_TYPES) expect({ width: t.width, height: t.height, required: t.required }).toEqual(FIELD_DEFAULTS[t.type]);
    expect(FIXED_FORM_FIELD_TYPES.find((t) => t.type === 'SIGNATURE')).toMatchObject({ width: 230, height: 50, required: true });
    expect(FIXED_FORM_FIELD_TYPES.find((t) => t.type === 'TEXT')).toMatchObject({ width: 230, height: 22, required: false });
    expect(FIXED_FORM_FIELD_TYPES.find((t) => t.type === 'CHECKBOX')).toMatchObject({ width: 18, height: 18, required: false });
  });

  it('a placed field takes the catalog default size and required default', async () => {
    const ds = source();
    render(<FixedFormStudio dataSource={ds} templateId="t1" canManage loadPdfFn={fakeLoad} />);
    await screen.findByTestId('ffs-page-0');
    fireEvent.click(screen.getByTestId('ffs-add-SIGNATURE'));
    fireEvent.click(screen.getByTestId('ffs-add-TEXT'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(ds.saveLayout).toHaveBeenCalled());
    const body = (ds.saveLayout as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { fields: Array<Record<string, unknown>> };
    expect(body.fields[0]).toMatchObject({ field_type: 'SIGNATURE', width: 230, height: 50, required: true });
    expect(body.fields[1]).toMatchObject({ field_type: 'TEXT', width: 230, height: 22, required: false });
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

  it('FIELD-PARITY-1 P0-1 — the target page follows the scrolled page column; a new field lands in its visible part', async () => {
    const page = { width: 612, height: 792 };
    const three = vi.fn(async (): Promise<LoadedPdf> => ({ pages: [page, page, page], render: async () => undefined, destroy: () => undefined }));
    const pdf = { asset_id: 'a1', sha256: 'f'.repeat(64), byte_size: 2048, page_count: 3, pages: [page, page, page] };
    const ds = source({ view: vi.fn(async () => view({ content: { ...view().content, pdf } })) });
    // Layout stand-in (jsdom has none): the column sits at y 100..900 (cut to jsdom's 768px
    // window); pages are 720×932px with a 16px gap, shifted up by the column's scrollTop.
    let scrollTop = 0;
    const s = 720 / 612;
    const rect = (left: number, top: number, w: number, h: number) => ({ left, top, right: left + w, bottom: top + h, width: w, height: h, x: left, y: top, toJSON: () => ({}) });
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset['testid'] === 'ffs-center') return rect(300, 100, 840, 800) as DOMRect;
      const m = /^ffs-page-(\d+)$/.exec(this.dataset['testid'] ?? '');
      if (m !== null) return rect(360, 116 + Number(m[1]) * (792 * s + 16) - scrollTop, 720, 792 * s) as DOMRect;
      return rect(0, 0, 0, 0) as DOMRect;
    });
    try {
      render(<FixedFormStudio dataSource={ds} templateId="t1" canManage loadPdfFn={three} />);
      await screen.findByTestId('ffs-page-2');
      expect(screen.getByText(/Fields are added to page 1\./)).toBeInTheDocument();

      // Scroll the column so page 3 fills the view, its top 184px above the column's top.
      scrollTop = 2 * (792 * s + 16) + 116 - 100 + 184;
      fireEvent.scroll(screen.getByTestId('ffs-center'));
      expect(await screen.findByText(/Fields are added to page 3\./)).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('ffs-add-TEXT'));
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(ds.saveLayout).toHaveBeenCalled());
      const saved = (ds.saveLayout as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as { fields: Array<{ page_number: number; x: number; y: number; height: number }> };
      const f = saved.fields[0] ?? { page_number: -1, x: -1, y: -1, height: 0 };
      expect(f.page_number).toBe(2);
      // Page 3's top is 184px above the view → the visible region starts 184/s pt down the page;
      // the field sits 72pt inside it (top-left frame), stored bottom-left.
      const top = 792 - f.y - f.height;
      expect(top).toBeCloseTo(184 / s + 72, 1);
      expect(f.x).toBe(72);

      // A click on a page still selects it explicitly.
      fireEvent.pointerDown(screen.getByTestId('ffs-page-0'));
      expect(screen.getByText(/Fields are added to page 1\./)).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
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

describe('FIELD-PARITY-2 A-4 — the sender-filled toggle follows the view flag', () => {
  it('is hidden while sender_filled_fields_enabled is false', async () => {
    render(<FixedFormStudio dataSource={source()} templateId="t1" canManage loadPdfFn={fakeLoad} />);
    await screen.findByTestId('ffs-page-0');
    fireEvent.click(screen.getByTestId('ffs-add-TEXT'));
    expect(screen.getByTestId('ffs-inspector')).toBeInTheDocument();
    expect(screen.queryByTestId('ffs-sender-filled')).toBeNull();
  });

  it('is offered, with read-only, when sender_filled_fields_enabled is true', async () => {
    const ds = source({ view: vi.fn(async () => view({ sender_filled_fields_enabled: true })) });
    render(<FixedFormStudio dataSource={ds} templateId="t1" canManage loadPdfFn={fakeLoad} />);
    await screen.findByTestId('ffs-page-0');
    fireEvent.click(screen.getByTestId('ffs-add-TEXT'));
    fireEvent.click(await screen.findByTestId('ffs-sender-filled'));
    expect(screen.getByTestId('ffs-read-only')).toBeInTheDocument();
  });
});
