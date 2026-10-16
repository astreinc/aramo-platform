import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { RtrDraftEditor } from './RtrDraftEditor';
import {
  RIGHT_TO_REPRESENT_TYPE_ID,
  type DocumentTemplateView,
  type TemplateBinding,
  type TemplateCatalog,
  type TemplateVersionView,
} from './document-templates-api';

// DOC-TEMPLATE-ADMIN-RTR-1 Amendment A1 — the rtr-html-v1 editor (mocks the shared
// contract): B/I/U marks, H/•/1. block conversions, client-side paste sanitisation, the
// tenant-logo letterhead with availability gating, the server's sanitized html re-render,
// sample-value highlights + SAMPLE VALUES panel, and 422 unknown_field / logo_position.

function makeSession(scopes: readonly string[]): Session {
  return { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't1', scopes: [...scopes], iat: 0, exp: 0 };
}
const MANAGER = makeSession(['document_template:read', 'document_template:manage']);
const RTR_TEMPLATE: DocumentTemplateView = {
  id: 'tpl-rtr', tenant_id: 't1', document_type_id: RIGHT_TO_REPRESENT_TYPE_ID, client_id: null,
  name: 'Standard Right to Represent', description: null, template_kind: 'GENERATED', status: 'ACTIVE',
  current_version_id: 'v1', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
};
const BINDINGS: readonly TemplateBinding[] = [
  { key: 'talent.full_name', label: 'Talent full name', group: 'Talent' },
  { key: 'client.name', label: 'Client name', group: 'Client' },
];
const HTML = '<p>Hi <span data-field="talent.full_name"></span></p><h2>Scope</h2><ul><li>One</li><li>Two</li></ul>';

function mkVersion(id: string, n: number, status: TemplateVersionView['status'], html: string, extra: Partial<TemplateVersionView> = {}): TemplateVersionView {
  return {
    id, tenant_id: 't1', template_id: 'tpl-rtr', version_number: n, status, render_schema_version: 'rtr-html-v1',
    field_schema: { render_schema_version: 'rtr-html-v1', title: 'Right to Represent', html },
    binding_schema: null, created_by: 'u1', created_at: '2026-01-01T00:00:00.000Z', activated_at: status === 'ACTIVE' ? '2026-01-01T00:00:00.000Z' : null,
    activated_by: status === 'DRAFT' ? null : 'u1', retired_at: null, content_fingerprint: 'fp', previewed_fingerprint: null, logo: null, ...extra,
  };
}
type Saved = { field_schema: { render_schema_version: string; title: string; html: string }; render_schema_version: string };
function lastSave(fn: unknown): Saved {
  const calls = (fn as ReturnType<typeof vi.fn>).mock.calls;
  return (calls[calls.length - 1] as [string, Saved])[1];
}
function apiErr(status: number, reason: string): Error {
  return Object.assign(new Error(`Request failed ${status}`), { status, code: 'X', details: { reason } });
}

function harness(opts: { html?: string; tenantLogo?: TemplateCatalog['tenantLogo']; draftExtra?: Partial<TemplateVersionView> } & Record<string, unknown> = {}) {
  const { html = HTML, tenantLogo = { available: true, tenant_name: 'Astre Consulting Services Inc' }, draftExtra = {}, ...overrides } = opts;
  const draft = mkVersion('v2', 2, 'DRAFT', html, draftExtra);
  const props = {
    sessionOverride: MANAGER,
    listTemplatesFn: () => Promise.resolve([RTR_TEMPLATE]),
    listVersionsFn: () => Promise.resolve([mkVersion('v1', 1, 'ACTIVE', '<p>Old</p>', { previewed_fingerprint: 'fp' }), draft]),
    catalogFn: (): Promise<TemplateCatalog> => Promise.resolve({ bindings: BINDINGS, tenantLogo }),
    resolveNamesFn: () => Promise.resolve({ u1: 'Purush Pichaimuthu' }),
    updateFn: vi.fn().mockImplementation((_id: string, input: Saved) => Promise.resolve({ ...draft, field_schema: input.field_schema })),
    renameFn: vi.fn(),
    discardFn: vi.fn(),
    previewFn: vi.fn().mockResolvedValue({ title: 'Right to Represent', html: '<p>Hi Ravi</p>' }),
    activateFn: vi.fn(),
    captureLogoFn: vi.fn().mockResolvedValue({ asset_id: 'a1', sha256: 'h', mime: 'image/png' }),
    removeLogoFn: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/d']}>
        <Routes><Route path="/d" element={<RtrDraftEditor {...(props as Parameters<typeof RtrDraftEditor>[0])} />} /></Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
  return props;
}

// Put a real DOM selection in a block box and let the editor record it (mouseup).
function select(box: HTMLElement, node: Node, start: number, end: number) {
  const r = document.createRange();
  r.setStart(node, start);
  r.setEnd(node, end);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r);
  fireEvent.mouseUp(box);
}
async function saveAndGet(props: ReturnType<typeof harness>) {
  fireEvent.click(screen.getByTestId('rtr-editor-save'));
  await waitFor(() => expect(props.updateFn).toHaveBeenCalled());
  return lastSave(props.updateFn);
}

describe('RtrDraftEditor — rtr-html-v1 (Amendment A1)', () => {
  it('renders the full FORMAT row (B · I · U · H · • · 1.) + Tenant logo, and block labels from the html', async () => {
    harness();
    await screen.findByTestId('rtr-para-0');
    const tools = within(screen.getByRole('toolbar', { name: 'Format' })).getAllByRole('button');
    expect(tools.map((t) => t.textContent)).toEqual(['B', 'I', 'U', 'H', '•', '1.']);
    expect(screen.getByTestId('rtr-logo-add')).toHaveTextContent('Tenant logo');
    expect(screen.getByTestId('rtr-para-label-0')).toHaveTextContent('Paragraph 1');
    expect(screen.getByTestId('rtr-para-label-1')).toHaveTextContent('Heading');
    expect(screen.getByTestId('rtr-para-label-2')).toHaveTextContent('List');
    expect(screen.getByTestId('rtr-para-text-2').querySelectorAll('li')).toHaveLength(2);
    expect(screen.getByTestId('rtr-para-text-0').querySelector('[data-field="talent.full_name"]')).not.toBeNull();
    fireEvent.click(screen.getByTestId('rtr-tab-settings'));
    expect(screen.getByTestId('rtr-panel-settings')).toHaveTextContent('Text, headings, lists, fields, tenant logo');
  });

  it('B / I / U toggle marks on the selection and serialise to b / i / u (active state shown)', async () => {
    const props = harness({ html: '<p>Hello world</p>' });
    const box = await screen.findByTestId('rtr-para-text-0');
    select(box, box.firstChild as Text, 6, 11);
    fireEvent.click(screen.getByTestId('rtr-format-b'));
    expect(screen.getByTestId('rtr-format-b')).toHaveAttribute('aria-pressed', 'true');
    const bold = box.querySelector('b') as HTMLElement;
    const r = document.createRange();
    r.selectNodeContents(bold);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(r);
    fireEvent.mouseUp(box);
    fireEvent.click(screen.getByTestId('rtr-format-i'));
    fireEvent.click(screen.getByTestId('rtr-format-u'));
    const saved = await saveAndGet(props);
    expect(saved.render_schema_version).toBe('rtr-html-v1');
    expect(saved.field_schema.html).toBe('<p>Hello <b><i><u>world</u></i></b></p>');
  });

  it('H toggles p↔h2; • / 1. convert a block to ul / ol and back', async () => {
    const props = harness({ html: '<p>a<br>b</p><p>c</p>' });
    const box0 = await screen.findByTestId('rtr-para-text-0');
    fireEvent.focus(box0);
    fireEvent.click(screen.getByTestId('rtr-format-ul'));
    expect(screen.getByTestId('rtr-para-0')).toHaveAttribute('data-kind', 'ul');
    expect(screen.getByTestId('rtr-format-ul')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('rtr-format-ol'));
    expect(screen.getByTestId('rtr-para-0')).toHaveAttribute('data-kind', 'ol');
    fireEvent.focus(screen.getByTestId('rtr-para-text-1'));
    fireEvent.click(screen.getByTestId('rtr-format-heading'));
    expect(screen.getByTestId('rtr-para-1')).toHaveAttribute('data-kind', 'h2');
    expect((await saveAndGet(props)).field_schema.html).toBe('<ol><li>a</li><li>b</li></ol><h2>c</h2>');
    fireEvent.focus(screen.getByTestId('rtr-para-text-0'));
    fireEvent.click(screen.getByTestId('rtr-format-ol'));
    fireEvent.focus(screen.getByTestId('rtr-para-text-1'));
    fireEvent.click(screen.getByTestId('rtr-format-heading'));
    fireEvent.click(screen.getByTestId('rtr-editor-save'));
    await waitFor(() => expect(props.updateFn).toHaveBeenCalledTimes(2));
    expect(lastSave(props.updateFn).field_schema.html).toBe('<p>a<br>b</p><p>c</p>');
  });

  it('paste is sanitised client-side: script/style/img/attributes stripped, allowlisted marks kept', async () => {
    const props = harness({ html: '<p>Start</p>' });
    const box = await screen.findByTestId('rtr-para-text-0');
    select(box, box.firstChild as Text, 5, 5);
    const html = '<p style="color:red" class="x">Pasted <b onclick="y()">bold</b></p><script>bad()</script><style>p{}</style><img src="x" onerror="z()">';
    fireEvent.paste(box, { clipboardData: { getData: (t: string) => (t === 'text/html' ? html : 'plain fallback'), types: ['text/html'] } });
    expect(box.querySelector('script,style,img,[style],[onclick],[class="x"]')).toBeNull();
    const saved = (await saveAndGet(props)).field_schema.html;
    expect(saved).toBe('<p>StartPasted <b>bold</b></p>');
  });

  it('plain-text paste falls back to text/plain', async () => {
    const props = harness({ html: '<p>A</p>' });
    const box = await screen.findByTestId('rtr-para-text-0');
    select(box, box.firstChild as Text, 1, 1);
    fireEvent.paste(box, { clipboardData: { getData: (t: string) => (t === 'text/plain' ? ' <b>not markup</b>' : '') } });
    expect((await saveAndGet(props)).field_schema.html).toBe('<p>A &lt;b&gt;not markup&lt;/b&gt;</p>');
  });

  it('Tenant logo adds the Letterhead row (logo first in the saved html); Remove logo takes it out', async () => {
    const props = harness();
    fireEvent.click(await screen.findByTestId('rtr-logo-add'));
    await waitFor(() => expect(props.captureLogoFn).toHaveBeenCalledWith('v2'));
    const row = await screen.findByTestId('rtr-letterhead-row');
    expect(row).toHaveTextContent('Letterhead');
    expect(row).toHaveTextContent('Astre Consulting Services Inc');
    expect(row).toHaveTextContent('Tenant logo · from Tenant profile');
    expect(within(row).getByRole('img')).toHaveAttribute('src', '/v1/document-templates/versions/v2/logo/content?v=a1');
    expect((await saveAndGet(props)).field_schema.html.startsWith('<div data-asset="tenant.logo"></div><p>')).toBe(true);
    fireEvent.click(screen.getByTestId('rtr-logo-remove'));
    await waitFor(() => expect(props.removeLogoFn).toHaveBeenCalledWith('v2'));
    await waitFor(() => expect(screen.queryByTestId('rtr-letterhead-row')).toBeNull());
    fireEvent.click(screen.getByTestId('rtr-editor-save'));
    await waitFor(() => expect(props.updateFn).toHaveBeenCalledTimes(2));
    expect(lastSave(props.updateFn).field_schema.html).not.toContain('tenant.logo');
  });

  it('a draft that already has a logo shows the Letterhead row and "Remove logo"', async () => {
    harness({ html: `<div data-asset="tenant.logo"></div>${HTML}`, draftExtra: { logo: { asset_id: 'z9', mime: 'image/png' } } });
    expect(await screen.findByTestId('rtr-letterhead-row')).toBeInTheDocument();
    expect(screen.getByTestId('rtr-logo-remove')).toHaveTextContent('Remove logo');
  });

  it('Tenant logo is disabled with guidance when the tenant has no profile logo (or the catalog says nothing)', async () => {
    harness({ tenantLogo: { available: false, tenant_name: 'Astre' } });
    expect(await screen.findByTestId('rtr-logo-add')).toBeDisabled();
    expect(screen.getByTestId('rtr-logo-add-wrap')).toHaveAttribute('title', 'Add a logo in Settings → Tenant profile');
  });

  it('409 no_tenant_logo explains where to add one', async () => {
    harness({ captureLogoFn: vi.fn().mockRejectedValue(apiErr(409, 'no_tenant_logo')) });
    fireEvent.click(await screen.findByTestId('rtr-logo-add'));
    expect(await screen.findByText('Add a logo in Settings → Tenant profile')).toBeInTheDocument();
    expect(screen.queryByTestId('rtr-letterhead-row')).toBeNull();
  });

  it('re-renders from the server’s sanitized html after save', async () => {
    const props = harness({
      html: '<p>Hello</p>',
      updateFn: vi.fn().mockImplementation(() => Promise.resolve(mkVersion('v2', 2, 'DRAFT', '<p>Server cleaned</p>'))),
    });
    const box = await screen.findByTestId('rtr-para-text-0');
    box.textContent = 'Hello <x>';
    fireEvent.input(box);
    fireEvent.click(screen.getByTestId('rtr-editor-save'));
    await waitFor(() => expect(props.updateFn).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('rtr-para-text-0')).toHaveTextContent('Server cleaned'));
  });

  it('chip × still works inside formatted text', async () => {
    const props = harness({ html: '<p><b>Hi <span data-field="client.name"></span></b> <span data-field="talent.full_name"></span></p>' });
    const box = await screen.findByTestId('rtr-para-text-0');
    fireEvent.click(within(box).getByLabelText('Remove Client name'));
    expect((await saveAndGet(props)).field_schema.html).toBe('<p><b>Hi </b> <span data-field="talent.full_name"></span></p>');
  });

  it('Insert field goes in at the caret; Job description inserts its own paragraph', async () => {
    const props = harness({
      html: '<p>Hi there</p>',
      catalogFn: () => Promise.resolve({ bindings: [...BINDINGS, { key: 'requisition.description', label: 'Requisition description', group: 'Requisition' }], tenantLogo: null }),
    });
    const box = await screen.findByTestId('rtr-para-text-0');
    select(box, box.firstChild as Text, 2, 2);
    fireEvent.click(screen.getByTestId('rtr-insert-field'));
    fireEvent.click(screen.getByTestId('rtr-binding-client.name'));
    fireEvent.click(screen.getByTestId('rtr-insert-field'));
    fireEvent.click(screen.getByTestId('rtr-binding-requisition.description'));
    expect(screen.getByTestId('rtr-para-label-1')).toHaveTextContent('Job description');
    expect((await saveAndGet(props)).field_schema.html).toBe(
      '<p>Hi<span data-field="client.name"></span>  there</p><p><span data-field="requisition.description"></span></p>',
    );
  });

  it('Preview renders highlighted sample values + the SAMPLE VALUES panel (tab and modal), with the letterhead', async () => {
    const previewFn = vi.fn().mockResolvedValue({
      title: 'Right to Represent',
      html: '<div data-asset="tenant.logo"></div><p>Hi <b><span data-sample="talent.full_name" onclick="x()">Ravi Shankar</span></b></p><script>bad()</script>',
      logo: { asset_id: 'z9', mime: 'image/png' },
      sample_values: [
        { key: 'talent.full_name', label: 'Talent full name', value: 'Ravi Shankar' },
        { key: 'client.name', label: 'Client name', value: 'Mindlance' },
      ],
      signature_block: { printed_name: 'Ravi Shankar' },
    });
    harness({ previewFn });
    fireEvent.click(await screen.findByTestId('rtr-tab-preview'));
    const paper = await screen.findByTestId('rtr-inline-preview-paper');
    const hl = paper.querySelector('.dt-sample[data-sample="talent.full_name"]');
    expect(hl).toHaveTextContent('Ravi Shankar');
    expect(hl?.closest('b')).not.toBeNull();
    expect(hl).not.toHaveAttribute('onclick');
    expect(paper.querySelector('script')).toBeNull();
    expect(within(paper).getByTestId('dt-doc-letterhead')).toBeInTheDocument();
    const panel = screen.getByTestId('dt-sample-values');
    expect(panel).toHaveTextContent('SAMPLE VALUES');
    expect(panel).toHaveTextContent('Client name');
    expect(panel).toHaveTextContent('Mindlance');
    expect(within(paper).getByTestId('dt-preview-signature').querySelector('.dt-sample')).toHaveTextContent('Ravi Shankar');
    fireEvent.click(screen.getByTestId('rtr-editor-preview'));
    const modal = await screen.findByTestId('dt-preview-modal');
    expect(modal).toHaveTextContent('SAMPLE VALUES');
    expect(modal).toHaveTextContent('Highlighted text is filled from these values.');
  });

  it('a v1 preview with sample_values shows the panel too (no fabricated highlights)', async () => {
    const previewFn = vi.fn().mockResolvedValue({
      title: 'RTR', blocks: [{ type: 'TEXT', text: 'Hi Ravi Shankar' }],
      sample_values: [{ key: 'talent.full_name', label: 'Talent full name', value: 'Ravi Shankar' }],
    });
    harness({ previewFn });
    fireEvent.click(await screen.findByTestId('rtr-tab-preview'));
    const paper = await screen.findByTestId('rtr-inline-preview-paper');
    expect(paper).toHaveTextContent('Hi Ravi Shankar');
    expect(paper.querySelector('.dt-sample')).toBeNull();
    expect(screen.getByTestId('dt-sample-values')).toHaveTextContent('Talent full name');
  });

  it('422 unknown_field → inline error, draft kept', async () => {
    harness({ updateFn: vi.fn().mockRejectedValue(apiErr(422, 'unknown_field')) });
    const box = await screen.findByTestId('rtr-para-text-0');
    box.textContent = 'Edited text';
    fireEvent.input(box);
    fireEvent.click(screen.getByTestId('rtr-editor-save'));
    expect(await screen.findByTestId('rtr-save-issue')).toHaveTextContent('isn’t a governed field');
    expect(screen.getByTestId('rtr-editor-save-state')).toHaveTextContent('Not saved');
    expect(screen.getByTestId('rtr-para-text-0')).toHaveTextContent('Edited text');
  });

  it('422 logo_position → inline error', async () => {
    harness({ updateFn: vi.fn().mockRejectedValue(apiErr(422, 'logo_position')) });
    fireEvent.change(await screen.findByTestId('rtr-editor-title'), { target: { value: 'RTR' } });
    fireEvent.click(screen.getByTestId('rtr-editor-save'));
    expect(await screen.findByTestId('rtr-save-issue')).toHaveTextContent('The tenant logo must be the first block of the document.');
  });
});

describe('RtrDraftEditor — an existing v1 DRAFT stays v1', () => {
  it('opens with only the Heading tool (no B/I/U/lists/logo) and saves as rtr-generated-v1', async () => {
    const v1 = (id: string, n: number, status: TemplateVersionView['status']): TemplateVersionView => ({
      ...mkVersion(id, n, status, ''),
      render_schema_version: 'rtr-generated-v1',
      field_schema: { render_schema_version: 'rtr-generated-v1', title: 'Right to Represent', blocks: [{ type: 'TEXT', text: 'Hi {{talent.full_name}}' }] },
    });
    const updateFn = vi.fn().mockImplementation(() => Promise.resolve(v1('v2', 2, 'DRAFT')));
    render(
      <ToastProvider>
        <MemoryRouter>
          <RtrDraftEditor
            sessionOverride={MANAGER}
            listTemplatesFn={() => Promise.resolve([RTR_TEMPLATE])}
            listVersionsFn={() => Promise.resolve([v1('v1', 1, 'ACTIVE'), v1('v2', 2, 'DRAFT')])}
            catalogFn={() => Promise.resolve({ bindings: BINDINGS, tenantLogo: { available: true, tenant_name: 'Astre' } })}
            resolveNamesFn={() => Promise.resolve({})}
            updateFn={updateFn}
          />
        </MemoryRouter>
      </ToastProvider>,
    );
    await screen.findByTestId('rtr-para-0');
    const tools = within(screen.getByRole('toolbar', { name: 'Format' })).getAllByRole('button');
    expect(tools.map((t) => t.textContent)).toEqual(['H']);
    expect(screen.queryByTestId('rtr-logo-add')).toBeNull();
    fireEvent.change(screen.getByTestId('rtr-editor-title'), { target: { value: 'RTR v2' } });
    fireEvent.click(screen.getByTestId('rtr-editor-save'));
    await waitFor(() => expect(updateFn).toHaveBeenCalled());
    const body = (updateFn.mock.calls[0] as [string, { render_schema_version: string; field_schema: { blocks: unknown } }])[1];
    expect(body.render_schema_version).toBe('rtr-generated-v1');
    expect(body.field_schema.blocks).toEqual([{ type: 'TEXT', text: 'Hi {{talent.full_name}}' }]);
  });
});
