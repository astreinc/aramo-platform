import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { RtrDraftEditor } from './RtrDraftEditor';
import {
  RIGHT_TO_REPRESENT_TYPE_ID,
  type DocumentTemplateView,
  type TemplateBinding,
  type TemplateVersionView,
} from './document-templates-api';

// DOC-TEMPLATE-ADMIN-RTR-1 (§11/§18/§59) — the RTR draft editor styled to the prototype.
// Proves: the Insert-field palette is the SERVER catalog (only governed fields, no
// agreed-pay); the §18 gate (Approve disabled until the saved content is previewed,
// re-armed by any edit); and Approve → activate → navigate to the detail success state.

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
function mkVersion(id: string, n: number, status: TemplateVersionView['status'], previewed: boolean): TemplateVersionView {
  return {
    id, tenant_id: 't1', template_id: 'tpl-rtr', version_number: n, status, render_schema_version: 'rtr-generated-v1',
    field_schema: { render_schema_version: 'rtr-generated-v1', title: 'Right to Represent', blocks: [{ type: 'TEXT', text: 'Hi {{talent.full_name}}' }] },
    binding_schema: null, created_by: 'u1', created_at: '2026-01-01T00:00:00.000Z', activated_at: status === 'ACTIVE' ? '2026-01-01T00:00:00.000Z' : null,
    activated_by: status === 'DRAFT' ? null : 'u1', retired_at: null, content_fingerprint: 'fp', previewed_fingerprint: previewed ? 'fp' : null,
  };
}

const HEADING_SCHEMA = {
  render_schema_version: 'rtr-generated-v1',
  title: 'Right to Represent',
  blocks: [
    { type: 'HEADING', text: 'Scope of representation' },
    { type: 'TEXT', text: 'Hi {{talent.full_name}}' },
  ],
};

const ALL_BINDINGS: readonly TemplateBinding[] = [
  { key: 'talent.full_name', label: 'Talent full name', group: 'Talent' },
  { key: 'client.name', label: 'Client name', group: 'Client' },
  { key: 'requisition.title', label: 'Requisition title', group: 'Requisition' },
  { key: 'requisition.reference', label: 'Requisition reference', group: 'Requisition' },
  { key: 'recruiting_company.name', label: 'Recruiting organization name', group: 'Recruiting organization' },
  { key: 'recruiter.display_name', label: 'Recruiter name', group: 'Recruiter' },
];

// Simulate typing into a contentEditable block (plain text) — the editor serialises on input.
function typeInto(el: HTMLElement, text: string) {
  el.textContent = text;
  fireEvent.input(el);
}
type SavedBody = { field_schema: { title: string; blocks: Array<{ type: string; text: string }> }; internal_notes?: string | null };
function lastSave(fn: unknown): SavedBody {
  const calls = (fn as ReturnType<typeof vi.fn>).mock.calls;
  return (calls[calls.length - 1] as [string, SavedBody])[1];
}

function harness(overrides: Partial<Parameters<typeof RtrDraftEditor>[0]> = {}, draftSchema?: unknown, draftExtra: Record<string, unknown> = {}) {
  const base = mkVersion('v2', 2, 'DRAFT', false);
  const draft = { ...(draftSchema !== undefined ? { ...base, field_schema: draftSchema } : base), ...draftExtra } as TemplateVersionView;
  const props = {
    sessionOverride: MANAGER,
    listTemplatesFn: () => Promise.resolve([RTR_TEMPLATE]),
    listVersionsFn: () => Promise.resolve([mkVersion('v1', 1, 'ACTIVE', true), draft]),
    listBindingsFn: () => Promise.resolve(BINDINGS),
    resolveNamesFn: () => Promise.resolve({ u1: 'Purush Pichaimuthu' }),
    updateFn: vi.fn().mockResolvedValue(draft),
    renameFn: vi.fn().mockImplementation((_id: string, input: { name: string }) => Promise.resolve({ ...RTR_TEMPLATE, name: input.name })),
    discardFn: vi.fn().mockResolvedValue(undefined),
    previewFn: vi.fn().mockResolvedValue({ title: 'Right to Represent', blocks: [{ type: 'TEXT', text: 'Hi Ravi Shankar' }] }),
    activateFn: vi.fn().mockResolvedValue({ ...draft, status: 'ACTIVE' as const }),
    ...overrides,
  };
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/admin/settings/document-templates/rtr/draft']}>
        <Routes>
          <Route path="/admin/settings/document-templates/rtr/draft" element={<RtrDraftEditor {...props} />} />
          <Route path="/admin/settings/document-templates/rtr" element={<div data-testid="rtr-detail-landing" />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
  return props;
}

describe('RtrDraftEditor (§11)', () => {
  it('Insert-field palette is the server catalog — only governed fields, no agreed-pay', async () => {
    harness();
    fireEvent.click(await screen.findByTestId('rtr-insert-field'));
    expect(await screen.findByTestId('rtr-binding-talent.full_name')).toHaveTextContent('Talent full name');
    expect(screen.getByTestId('rtr-binding-client.name')).toBeInTheDocument();
    expect(screen.queryByTestId('rtr-binding-agreed_pay_rate.amount')).toBeNull();
  });

  it('enforces the §18 gate: Approve blocked until a clean preview, re-armed by any edit', async () => {
    const props = harness();
    const approve = (await screen.findByTestId('rtr-editor-approve')) as HTMLButtonElement;
    expect(approve).toBeDisabled();

    fireEvent.click(screen.getByTestId('rtr-editor-preview'));
    await waitFor(() => expect(props.previewFn).toHaveBeenCalledWith('v2'));
    await waitFor(() => expect(screen.getByTestId('rtr-editor-approve')).not.toBeDisabled());

    // Any edit re-arms the gate.
    fireEvent.change(screen.getByTestId('rtr-editor-title'), { target: { value: 'RTR v2' } });
    expect(screen.getByTestId('rtr-editor-approve')).toBeDisabled();
  });

  it('Approve activates and navigates to the detail success state', async () => {
    const props = harness();
    fireEvent.click(await screen.findByTestId('rtr-editor-preview'));
    await waitFor(() => expect(screen.getByTestId('rtr-editor-approve')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('rtr-editor-approve'));
    fireEvent.click(await screen.findByTestId('dt-approve-confirm'));
    await waitFor(() => expect(props.activateFn).toHaveBeenCalledWith('v2'));
    expect(await screen.findByTestId('rtr-detail-landing')).toBeInTheDocument();
  });

  it('sits in the Settings gutter (.set-content); the sticky footer is outside it, in the main column', async () => {
    harness();
    const page = await screen.findByTestId('rtr-editor-page');
    expect(page).toHaveClass('set-content');
    const footer = screen.getByTestId('rtr-editor-footer');
    expect(page.contains(footer)).toBe(false);
    expect(footer.parentElement).toHaveClass('dt-root');
  });

  it('Preview renders the SERVER render as returned — no client sample table, agreed-pay, or signature lines', async () => {
    const previewFn = vi.fn().mockResolvedValue({
      title: 'Right to Represent — Sample',
      blocks: [
        { type: 'HEADING', text: 'Scope of representation' },
        { type: 'TEXT', text: 'Hi Server Sample Talent' },
      ],
    });
    harness({ previewFn }, HEADING_SCHEMA);
    fireEvent.click(await screen.findByTestId('rtr-editor-preview'));
    const paper = await screen.findByTestId('dt-preview-paper');
    expect(previewFn).toHaveBeenCalledWith('v2');
    expect(paper).toHaveTextContent('Right to Represent — Sample');
    expect(paper).toHaveTextContent('Hi Server Sample Talent');
    expect(screen.getByTestId('dt-preview-heading')).toHaveTextContent('Scope of representation');
    const modal = screen.getByTestId('dt-preview-modal');
    expect(modal.textContent).not.toContain('SAMPLE VALUES');
    expect(modal.textContent).not.toMatch(/agreed pay|Talent signature|Ravi Shankar|Pay period/i);
    expect(modal).toHaveTextContent('Real RTRs use the talent and requisition on record when sent.');
  });

  it('keeps HEADING blocks on save; new paragraphs are TEXT', async () => {
    const props = harness({}, HEADING_SCHEMA);
    expect(await screen.findByTestId('rtr-para-0')).toHaveAttribute('data-block-type', 'HEADING');
    fireEvent.click(screen.getByTestId('rtr-add-para'));
    typeInto(screen.getByTestId('rtr-para-text-2'), 'Closing [Client name]');
    fireEvent.click(screen.getByTestId('rtr-editor-save'));
    await waitFor(() => expect(props.updateFn).toHaveBeenCalled());
    const [vid, body] = (props.updateFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { field_schema: { blocks: Array<{ type: string; text: string }> } }];
    expect(vid).toBe('v2');
    expect(body.field_schema.blocks).toEqual([
      { type: 'HEADING', text: 'Scope of representation' },
      { type: 'TEXT', text: 'Hi {{talent.full_name}}' },
      { type: 'TEXT', text: 'Closing {{client.name}}' },
    ]);
  });

  it('Save draft PATCHes the template name only when it changed', async () => {
    const props = harness();
    fireEvent.change(await screen.findByTestId('rtr-editor-title'), { target: { value: 'RTR v2' } });
    fireEvent.click(screen.getByTestId('rtr-editor-save'));
    await waitFor(() => expect(props.updateFn).toHaveBeenCalledTimes(1));
    expect(props.renameFn).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('rtr-editor-name'), { target: { value: 'Astre RTR' } });
    fireEvent.click(screen.getByTestId('rtr-editor-save'));
    await waitFor(() => expect(props.renameFn).toHaveBeenCalledWith('tpl-rtr', { name: 'Astre RTR' }));
    await waitFor(() => expect(props.updateFn).toHaveBeenCalledTimes(2));
  });

  it('shows a save error when the save fails', async () => {
    harness({ updateFn: vi.fn().mockRejectedValue(new Error('boom')) });
    fireEvent.change(await screen.findByTestId('rtr-editor-title'), { target: { value: 'RTR v2' } });
    fireEvent.click(screen.getByTestId('rtr-editor-save'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Not saved/);
  });

  it('Discard draft confirms, calls DELETE for the draft, and returns to the RTR detail', async () => {
    const props = harness();
    fireEvent.click(await screen.findByTestId('rtr-editor-discard'));
    const modal = await screen.findByTestId('dt-discard-modal');
    expect(modal).toHaveTextContent('Discard draft v2?');
    expect(modal).toHaveTextContent('Your changes are deleted. The active version is unchanged.');
    fireEvent.click(screen.getByTestId('dt-discard-confirm'));
    await waitFor(() => expect(props.discardFn).toHaveBeenCalledWith('v2'));
    expect(await screen.findByTestId('rtr-detail-landing')).toBeInTheDocument();
  });

  it('a non-manager is refused the editor', async () => {
    harness({ sessionOverride: makeSession(['document_template:read']) });
    expect(await screen.findByText(/don’t have permission/i)).toBeInTheDocument();
    expect(screen.queryByTestId('rtr-editor-approve')).toBeNull();
  });

  // ── Draft editor v2 (§9) ──────────────────────────────────────────────
  it('renders the v2 layout: details, tabs, builder, signature row, rail cards, footer', async () => {
    harness();
    expect(await screen.findByTestId('rtr-template-details')).toHaveTextContent('Template details');
    expect(screen.getByTestId('rtr-editor-header')).toHaveTextContent('Right to Represent · v2');
    expect(screen.getByText(/not used by any workflow until approved/)).toHaveTextContent('Based on v1');
    const tabs = within(screen.getByRole('tablist')).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Document builder', 'Preview', 'Versions', 'Settings']);
    expect(screen.getByTestId('rtr-panel-builder')).toHaveTextContent('Document content');
    expect(screen.getByTestId('rtr-signature-row')).toHaveTextContent("It can't be edited, moved or deleted.");
    expect(screen.getByTestId('rtr-rail-fields')).toHaveTextContent('Fields in this draft');
    expect(screen.getByTestId('rtr-checklist')).toHaveTextContent('Approval checklist');
    expect(screen.getByTestId('rtr-rail-history')).toHaveTextContent('Version history');
    expect(screen.getByTestId('rtr-editor-save-state')).toHaveTextContent('No changes yet');
    // Only the Heading tool persists with the v1 content model — no dead B/I/U/list/logo.
    expect(screen.getByTestId('rtr-format-heading')).toBeInTheDocument();
    expect(screen.queryByTitle(/Bold|Italic|Underline|Bulleted|Numbered/)).toBeNull();
    expect(screen.queryByText(/Tenant logo/)).toBeNull();
  });

  it('tabs switch with aria-selected; Versions lists every version; Settings is read-only facts', async () => {
    harness();
    fireEvent.click(await screen.findByTestId('rtr-tab-versions'));
    expect(screen.getByTestId('rtr-tab-versions')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('rtr-tab-builder')).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByTestId('rtr-tabver-2')).toHaveTextContent('Draft');
    expect(screen.getByTestId('rtr-tabver-1')).toHaveTextContent('Active');
    fireEvent.click(screen.getByTestId('rtr-tab-settings'));
    const panel = screen.getByTestId('rtr-panel-settings');
    expect(panel).toHaveTextContent('End of document (fixed)');
    expect(panel).toHaveTextContent('Headings and paragraphs with governed fields');
    expect(screen.queryByTestId('rtr-panel-builder')).toBeNull();
  });

  it('Preview tab calls the server preview, marks previewed (dot gone, item 5 ticks); a later edit re-arms', async () => {
    const props = harness();
    expect(await screen.findByTestId('rtr-preview-dot')).toBeInTheDocument();
    expect(screen.getByTestId('rtr-check-5')).toHaveAttribute('data-ok', 'false');
    fireEvent.click(screen.getByTestId('rtr-tab-preview'));
    await waitFor(() => expect(props.previewFn).toHaveBeenCalledWith('v2'));
    expect(await screen.findByTestId('rtr-inline-preview-paper')).toHaveTextContent('Hi Ravi Shankar');
    expect(screen.getByTestId('rtr-panel-preview')).toHaveTextContent('Sample preview data');
    expect(screen.queryByTestId('rtr-preview-dot')).toBeNull();
    expect(screen.getByTestId('rtr-check-5')).toHaveAttribute('data-ok', 'true');
    expect(screen.getByTestId('rtr-checklist-count')).toHaveTextContent('5 of 5');
    // No signature is drawn: the server response carries no signature_block.
    expect(screen.queryByTestId('dt-preview-signature')).toBeNull();
    fireEvent.change(screen.getByTestId('rtr-editor-title'), { target: { value: 'RTR v2' } });
    expect(screen.getByTestId('rtr-preview-dot')).toBeInTheDocument();
    expect(screen.getByTestId('rtr-check-5')).toHaveAttribute('data-ok', 'false');
    expect(screen.getByTestId('rtr-editor-approve')).toBeDisabled();
  });

  it('draws the signature in the preview only when the server appends one (signature_block)', async () => {
    const previewFn = vi.fn().mockResolvedValue({ title: 'RTR', blocks: [{ type: 'TEXT', text: 'Hi Ravi Shankar' }], signature_block: { printed_name: 'Ravi Shankar' } });
    harness({ previewFn });
    fireEvent.click(await screen.findByTestId('rtr-tab-preview'));
    const sig = await screen.findByTestId('dt-preview-signature');
    expect(sig).toHaveTextContent('TALENT SIGNATURE');
    expect(sig).toHaveTextContent('Ravi Shankar');
  });

  it('saving before preview when dirty, then preview', async () => {
    const props = harness();
    fireEvent.change(await screen.findByTestId('rtr-editor-title'), { target: { value: 'RTR v2' } });
    fireEvent.click(screen.getByTestId('rtr-tab-preview'));
    await waitFor(() => expect(props.previewFn).toHaveBeenCalled());
    expect(props.updateFn).toHaveBeenCalledTimes(1);
    expect(lastSave(props.updateFn).field_schema.title).toBe('RTR v2');
  });

  it('Insert field lists ONLY allowed keys, grouped by source (empty groups omitted)', async () => {
    harness({ listBindingsFn: () => Promise.resolve([...BINDINGS, { key: 'recruiter.display_name', label: 'Recruiter name', group: 'Recruiter' }]) });
    fireEvent.click(await screen.findByTestId('rtr-insert-field'));
    expect(screen.getByTestId('rtr-insert-group-talent')).toHaveTextContent('Talent full name');
    expect(screen.getByTestId('rtr-insert-group-client')).toHaveTextContent('Client name');
    expect(screen.getByTestId('rtr-insert-group-recruiter')).toHaveTextContent('Recruiter name');
    expect(screen.queryByTestId('rtr-insert-group-requisition')).toBeNull();
    expect(screen.queryByTestId('rtr-insert-group-pay')).toBeNull();
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);
  });

  it('Insert field with no focused block appends to the end of the last block', async () => {
    const props = harness();
    fireEvent.click(await screen.findByTestId('rtr-insert-field'));
    fireEvent.click(screen.getByTestId('rtr-binding-client.name'));
    fireEvent.click(screen.getByTestId('rtr-editor-save'));
    await waitFor(() => expect(props.updateFn).toHaveBeenCalled());
    expect(lastSave(props.updateFn).field_schema.blocks).toEqual([{ type: 'TEXT', text: 'Hi {{talent.full_name}} {{client.name}}' }]);
  });

  it('renders fields as atomic chips; chip × removes the token from the saved field_schema', async () => {
    const props = harness();
    const box = await screen.findByTestId('rtr-para-text-0');
    const chip = box.querySelector('[data-field="talent.full_name"]');
    expect(chip).not.toBeNull();
    expect(chip).toHaveAttribute('contenteditable', 'false');
    fireEvent.click(within(box).getByLabelText('Remove Talent full name'));
    expect(box.querySelector('[data-field]')).toBeNull();
    expect(screen.getByTestId('rtr-check-3')).toHaveAttribute('data-ok', 'false');
    fireEvent.click(screen.getByTestId('rtr-editor-save'));
    await waitFor(() => expect(props.updateFn).toHaveBeenCalled());
    expect(lastSave(props.updateFn).field_schema.blocks).toEqual([{ type: 'TEXT', text: 'Hi ' }]);
  });

  it('an unknown {{token}} shows a red "unknown field" chip and blocks approval', async () => {
    harness({}, { render_schema_version: 'rtr-generated-v1', title: 'RTR', blocks: [{ type: 'TEXT', text: 'Hi {{talent.full_name}} {{agreed_pay_rate.amount}}' }] });
    const box = await screen.findByTestId('rtr-para-text-0');
    expect(box.querySelector('[data-bad]')).toHaveTextContent('agreed_pay_rate.amount · unknown field');
    expect(screen.getByTestId('rtr-check-4')).toHaveAttribute('data-ok', 'false');
    expect(screen.getByTestId('rtr-editor-approve')).toBeDisabled();
  });

  it('Add clause hides the agreed-pay clause (and any clause whose fields are not governed)', async () => {
    const props = harness();
    fireEvent.click(await screen.findByTestId('rtr-add-clause'));
    expect(screen.getByTestId('rtr-clause-withdrawal')).toHaveTextContent('Withdrawal');
    expect(screen.getByTestId('rtr-clause-scope')).toBeInTheDocument();
    expect(screen.queryByTestId('rtr-clause-pay')).toBeNull();
    expect(screen.queryByTestId('rtr-clause-representation')).toBeNull(); // needs requisition/company keys
    fireEvent.click(screen.getByTestId('rtr-clause-scope'));
    expect(screen.getByTestId('rtr-para-label-1')).toHaveTextContent('Paragraph 2');
    fireEvent.click(screen.getByTestId('rtr-editor-save'));
    await waitFor(() => expect(props.updateFn).toHaveBeenCalled());
    expect(lastSave(props.updateFn).field_schema.blocks[1]).toEqual({ type: 'TEXT', text: 'This authorization applies only to the client and requisition identified above.' });
  });

  it('with the full live catalog the Representation clause is offered and inserts governed tokens; pay stays hidden', async () => {
    const props = harness({ listBindingsFn: () => Promise.resolve(ALL_BINDINGS) });
    fireEvent.click(await screen.findByTestId('rtr-add-clause'));
    expect(screen.queryByTestId('rtr-clause-pay')).toBeNull();
    fireEvent.click(screen.getByTestId('rtr-clause-representation'));
    fireEvent.click(screen.getByTestId('rtr-editor-save'));
    await waitFor(() => expect(props.updateFn).toHaveBeenCalled());
    expect(lastSave(props.updateFn).field_schema.blocks[1]?.text).toBe(
      'I authorize {{recruiting_company.name}} to represent me, {{talent.full_name}}, to {{client.name}} for the {{requisition.title}} opportunity ({{requisition.reference}}).',
    );
  });

  it('Job description (when governed) inserts as its own block labelled "Job description"', async () => {
    harness({ listBindingsFn: () => Promise.resolve([...BINDINGS, { key: 'requisition.description', label: 'Requisition description', group: 'Requisition' }]) });
    fireEvent.click(await screen.findByTestId('rtr-insert-field'));
    expect(screen.getByTestId('rtr-binding-requisition.description')).toHaveTextContent('Job description');
    fireEvent.click(screen.getByTestId('rtr-binding-requisition.description'));
    expect(screen.getByTestId('rtr-para-label-1')).toHaveTextContent('Job description');
  });

  it('block ··· menu: Move up / Move down / Duplicate / Delete', async () => {
    const props = harness({}, HEADING_SCHEMA);
    await screen.findByTestId('rtr-para-0');
    fireEvent.click(screen.getByTestId('rtr-para-menu-0'));
    expect(screen.getByTestId('rtr-para-up-0')).toBeDisabled();
    fireEvent.click(screen.getByTestId('rtr-para-down-0'));
    expect(screen.getByTestId('rtr-para-0')).toHaveAttribute('data-block-type', 'TEXT');
    expect(screen.getByTestId('rtr-para-1')).toHaveAttribute('data-block-type', 'HEADING');
    fireEvent.click(screen.getByTestId('rtr-para-menu-1'));
    fireEvent.click(screen.getByTestId('rtr-para-up-1'));
    expect(screen.getByTestId('rtr-para-0')).toHaveAttribute('data-block-type', 'HEADING');
    fireEvent.click(screen.getByTestId('rtr-para-menu-1'));
    fireEvent.click(screen.getByTestId('rtr-para-dup-1'));
    expect(screen.getByTestId('rtr-para-2')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('rtr-para-menu-0'));
    fireEvent.click(screen.getByTestId('rtr-para-del-0'));
    fireEvent.click(screen.getByTestId('rtr-editor-save'));
    await waitFor(() => expect(props.updateFn).toHaveBeenCalled());
    expect(lastSave(props.updateFn).field_schema.blocks).toEqual([
      { type: 'TEXT', text: 'Hi {{talent.full_name}}' },
      { type: 'TEXT', text: 'Hi {{talent.full_name}}' },
    ]);
  });

  it('the last remaining block cannot be removed — Delete resets it to empty', async () => {
    harness();
    await screen.findByTestId('rtr-para-0');
    fireEvent.click(screen.getByTestId('rtr-para-menu-0'));
    fireEvent.click(screen.getByTestId('rtr-para-del-0'));
    expect(screen.getByTestId('rtr-para-0')).toBeInTheDocument();
    expect(screen.queryByTestId('rtr-para-1')).toBeNull();
    expect(screen.getByTestId('rtr-para-text-0').textContent).toBe('');
    expect(screen.getByTestId('rtr-check-2')).toHaveAttribute('data-ok', 'false');
  });

  it('drag ⋮⋮ reorders blocks (dragstart → drop)', async () => {
    const props = harness({}, HEADING_SCHEMA);
    await screen.findByTestId('rtr-para-0');
    fireEvent.dragStart(screen.getByTestId('rtr-drag-1'));
    fireEvent.dragOver(screen.getByTestId('rtr-para-0'));
    expect(screen.getByTestId('rtr-para-0')).toHaveClass('dt-ed2row--drop');
    fireEvent.drop(screen.getByTestId('rtr-para-0'));
    expect(screen.getByTestId('rtr-para-0')).toHaveAttribute('data-block-type', 'TEXT');
    fireEvent.click(screen.getByTestId('rtr-editor-save'));
    await waitFor(() => expect(props.updateFn).toHaveBeenCalled());
    expect(lastSave(props.updateFn).field_schema.blocks.map((b) => b.type)).toEqual(['TEXT', 'HEADING']);
  });

  it('the H tool toggles the focused block between Heading and Paragraph', async () => {
    harness();
    const box = await screen.findByTestId('rtr-para-text-0');
    expect(screen.getByTestId('rtr-format-heading')).toBeDisabled();
    fireEvent.focus(box);
    fireEvent.click(screen.getByTestId('rtr-format-heading'));
    expect(screen.getByTestId('rtr-para-0')).toHaveAttribute('data-block-type', 'HEADING');
    expect(screen.getByTestId('rtr-para-label-0')).toHaveTextContent('Heading');
  });

  it('checklist gates Approve: missing Talent full name blocks it even after preview', async () => {
    harness({}, { render_schema_version: 'rtr-generated-v1', title: 'RTR', blocks: [{ type: 'TEXT', text: 'Hello {{client.name}}' }] });
    fireEvent.click(await screen.findByTestId('rtr-tab-preview'));
    await waitFor(() => expect(screen.getByTestId('rtr-check-5')).toHaveAttribute('data-ok', 'true'));
    expect(screen.getByTestId('rtr-check-3')).toHaveAttribute('data-ok', 'false');
    const approve = screen.getByTestId('rtr-editor-approve');
    expect(approve).toBeDisabled();
    expect(approve).toHaveAttribute('title', 'Insert Talent full name — an RTR must name the talent');
    expect(screen.getByTestId('rtr-footer-gate')).toHaveTextContent('Insert Talent full name');
    expect(screen.getByTestId('rtr-checklist-count')).toHaveTextContent('4 of 5');
  });

  it('an empty template name is flagged and blocks approval', async () => {
    harness();
    fireEvent.change(await screen.findByTestId('rtr-editor-name'), { target: { value: '' } });
    expect(screen.getByTestId('rtr-editor-name')).toHaveClass('dt-input--req');
    expect(screen.getByTestId('rtr-check-1')).toHaveAttribute('data-ok', 'false');
  });

  it('internal notes are omitted when the API version view has no internal_notes property', async () => {
    harness();
    await screen.findByTestId('rtr-template-details');
    expect(screen.queryByTestId('rtr-editor-notes')).toBeNull();
    expect(screen.queryByText('Internal notes / usage guidance')).toBeNull();
  });

  it('internal notes render when the API returns the property, count to 500, and are sent on save', async () => {
    const props = harness({}, undefined, { internal_notes: 'Use for contract roles' });
    const notes = (await screen.findByTestId('rtr-editor-notes')) as HTMLTextAreaElement;
    expect(notes.value).toBe('Use for contract roles');
    expect(notes).toHaveAttribute('maxLength', '500');
    expect(screen.getByText('22/500')).toBeInTheDocument();
    fireEvent.change(notes, { target: { value: 'Use for all roles' } });
    fireEvent.click(screen.getByTestId('rtr-editor-save'));
    await waitFor(() => expect(props.updateFn).toHaveBeenCalled());
    expect(lastSave(props.updateFn).internal_notes).toBe('Use for all roles');
  });

  it('notes unchanged → no internal_notes key in the PATCH', async () => {
    const props = harness({}, undefined, { internal_notes: null });
    fireEvent.change(await screen.findByTestId('rtr-editor-title'), { target: { value: 'RTR v2' } });
    fireEvent.click(screen.getByTestId('rtr-editor-save'));
    await waitFor(() => expect(props.updateFn).toHaveBeenCalled());
    expect('internal_notes' in lastSave(props.updateFn)).toBe(false);
  });

  it('rail: fields in use / unused, search filter, click inserts, group collapse', async () => {
    const props = harness();
    expect(await screen.findByTestId('rtr-fields-in-use')).toHaveTextContent('1 in use');
    expect(screen.getByTestId('rtr-railfield-talent.full_name')).toHaveClass('dt-railchip--used');
    expect(screen.getByTestId('rtr-railfield-client.name')).not.toHaveClass('dt-railchip--used');
    fireEvent.change(screen.getByTestId('rtr-field-search'), { target: { value: 'client' } });
    expect(screen.queryByTestId('rtr-railfield-talent.full_name')).toBeNull();
    fireEvent.click(screen.getByTestId('rtr-railfield-client.name'));
    expect(screen.getByTestId('rtr-fields-in-use')).toHaveTextContent('2 in use');
    fireEvent.change(screen.getByTestId('rtr-field-search'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('rtr-railgrp-talent'));
    expect(screen.queryByTestId('rtr-railfield-talent.full_name')).toBeNull();
    fireEvent.click(screen.getByTestId('rtr-editor-save'));
    await waitFor(() => expect(props.updateFn).toHaveBeenCalled());
    expect(lastSave(props.updateFn).field_schema.blocks[0]?.text).toBe('Hi {{talent.full_name}} {{client.name}}');
  });

  it('rail version history shows the last 3 with who; View all opens the Versions tab', async () => {
    harness();
    const hist = await screen.findByTestId('rtr-rail-history');
    expect(hist).toHaveTextContent('v2');
    expect(hist).toHaveTextContent('You');
    expect(hist).toHaveTextContent('Purush P.');
    fireEvent.click(screen.getByTestId('rtr-history-all'));
    expect(screen.getByTestId('rtr-tab-versions')).toHaveAttribute('aria-selected', 'true');
  });

  it('··· menu: View active (read-only) opens the stored wording; Preview with sample data opens the Preview tab', async () => {
    const props = harness();
    fireEvent.click(await screen.findByTestId('rtr-editor-more'));
    fireEvent.click(screen.getByTestId('rtr-more-view-active'));
    expect(await screen.findByTestId('dt-preview-modal')).toHaveTextContent('Template wording');
    fireEvent.click(screen.getByTestId('dt-preview-close'));
    fireEvent.click(screen.getByTestId('rtr-editor-more'));
    fireEvent.click(screen.getByTestId('rtr-more-preview'));
    await waitFor(() => expect(props.previewFn).toHaveBeenCalledWith('v2'));
    expect(screen.getByTestId('rtr-tab-preview')).toHaveAttribute('aria-selected', 'true');
  });

  it('footer is one non-wrapping row: every control is nowrap; save state + gate reason present', async () => {
    harness();
    const footer = await screen.findByTestId('rtr-editor-footer');
    expect(footer).toHaveClass('dt-footer');
    const buttons = within(footer).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Discard draft', 'Preview', 'Save draft', 'Approve & activate']);
    for (const b of buttons) expect(b).toHaveClass('dt-nowrap');
    expect(within(footer).getByText('Draft')).toHaveClass('dt-nowrap');
    expect(screen.getByTestId('rtr-footer-save-state')).toHaveClass('dt-footer__save');
    expect(screen.getByTestId('rtr-footer-gate')).toHaveTextContent('Preview required before approval');
  });

  it('save state reads "Draft saved · {time}" after a save', async () => {
    harness();
    fireEvent.change(await screen.findByTestId('rtr-editor-title'), { target: { value: 'RTR v2' } });
    expect(screen.getByTestId('rtr-editor-save-state')).toHaveTextContent('Unsaved changes');
    fireEvent.click(screen.getByTestId('rtr-editor-save'));
    await waitFor(() => expect(screen.getByTestId('rtr-editor-save-state')).toHaveTextContent(/Draft saved · \d{1,2}:\d{2}/));
  });

  it('paste inserts plain text only', async () => {
    harness();
    const box = await screen.findByTestId('rtr-para-text-0');
    fireEvent.paste(box, { clipboardData: { getData: (t: string) => (t === 'text/plain' ? ' pasted' : '<b>bold</b>') } });
    expect(box.querySelector('b')).toBeNull();
    expect(box.textContent).toContain('pasted');
  });
});
