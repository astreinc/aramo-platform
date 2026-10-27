import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IdentityProvider } from '../identity/identity';
import { platformSession } from '../skills/test-session';

import {
  documentTemplatesApi,
  type PlatformTemplateDetail,
  type TemplateVariable,
  type TemplateVersion,
} from './document-templates-api';
import { PlatformTemplateStudio as TemplateStudio } from './DocumentTemplateDetailView';

// TEMPLATE-STUDIO-1 S-0 — the shared lib Studio as platform-web hosts it (the platform data
// source + wrapper), so these assertions are the platform regression gate. Unchanged:
// PLATFORM-UX-1 F-9 — the Studio journey against the mocked platform API: publish gating
// (derived checks), preview saves first, the Checks fix, "/" and "{{", withdraw, compare,
// version restore, and the :read view.

const READ = ['platform:tenant:read', 'platform:document_template:read'];
const MANAGE = [...READ, 'platform:document_template:manage'];

const html = (title: string, body: string) => ({ render_schema_version: 'rtr-html-v1', title, html: body });

function version(id: string, n: number, status: TemplateVersion['status'], body: string, extra: Partial<TemplateVersion> = {}): TemplateVersion {
  return {
    id,
    template_id: 't1',
    version_number: n,
    status,
    render_schema_version: 'rtr-html-v1',
    field_schema: html('Offer of employment', body),
    activated_at: status === 'DRAFT' ? null : `2026-0${n}-02T10:00:00.000Z`,
    created_at: `2026-0${n}-01T10:00:00.000Z`,
    content_fingerprint: 'fp1',
    previewed_fingerprint: null,
    internal_notes: null,
    ...extra,
  };
}

const V1 = version('v1', 1, 'RETIRED', '<p>Dear <span data-field="talent.first_name"></span>,</p>');
const V2 = version('v2', 2, 'ACTIVE', '<h2>Offer</h2><p>Dear <span data-field="talent.first_name"></span>,</p>');
const DRAFT_BODY = '<h2>Offer</h2><p>Dear <span data-field="talent.first_name"></span>, welcome.</p><p></p>';

function detail(draft: TemplateVersion | null, extra: Partial<PlatformTemplateDetail> = {}): PlatformTemplateDetail {
  return {
    id: 't1',
    owner_scope: 'PLATFORM',
    document_type_id: 'dt-rtr',
    name: 'Offer letter',
    description: 'Default offer letter.',
    template_kind: 'GENERATED',
    status: 'ACTIVE',
    products: ['ATS', 'SIGN'],
    current_version: { id: 'v2', version_number: 2, status: 'ACTIVE', activated_at: '2026-02-02T10:00:00.000Z' },
    draft_version_id: draft?.id ?? null,
    withdraw_notice_at: null,
    withdraw_effective_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-10-20T00:00:00.000Z',
    versions: [...(draft ? [draft] : []), V2, V1],
    ...extra,
  };
}

const VARIABLES: TemplateVariable[] = [
  { id: 'a', key: 'talent.first_name', label: 'First name', group_label: 'Talent', data_type: 'TEXT', products: ['ATS'], ats_binding_key: 'talent.first_name', sample_value: 'Amina', active: true, created_at: '', updated_at: '' },
  { id: 'b', key: 'talent.full_name', label: 'Full name', group_label: 'Talent', data_type: 'TEXT', products: ['ATS'], ats_binding_key: 'talent.full_name', sample_value: 'Amina Diallo', active: true, created_at: '', updated_at: '' },
];

function mockApi(d: PlatformTemplateDetail) {
  vi.spyOn(documentTemplatesApi, 'getTemplate').mockResolvedValue(d);
  vi.spyOn(documentTemplatesApi, 'allowedBindings').mockResolvedValue({
    bindings: VARIABLES.map((v) => ({ key: v.key, label: v.label, group: v.group_label })),
  });
  vi.spyOn(documentTemplatesApi, 'listVariables').mockResolvedValue({ variables: VARIABLES });
  vi.spyOn(documentTemplatesApi, 'listDocumentTypes').mockResolvedValue({ document_types: [{ id: 'dt-rtr', key: 'rtr', name: 'Right to represent', configurable: true }] });
}

function renderStudio(scopes: string[]) {
  const session = platformSession(scopes);
  return render(
    <MemoryRouter>
      <IdentityProvider session={session} load={() => Promise.reject(new Error('no me'))}>
        <TemplateStudio session={session} templateId="t1" />
      </IdentityProvider>
    </MemoryRouter>,
  );
}

function blockEls(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-block-id]'));
}

function caretAtEnd(el: HTMLElement): void {
  const sel = window.getSelection();
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  sel?.removeAllRanges();
  sel?.addRange(r);
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true, writable: true });
});

describe('TemplateStudio (manage)', () => {
  it('renders the draft with {{key}} chips, the outline and the derived readiness', async () => {
    mockApi(detail(version('d3', 3, 'DRAFT', DRAFT_BODY)));
    renderStudio(MANAGE);
    await screen.findByRole('textbox', { name: 'Heading' });
    const chip = document.querySelector('.pws-chip');
    expect(chip?.textContent).toBe('{{talent.first_name}}');
    expect(chip?.getAttribute('data-state')).toBe('known');
    expect(screen.getByText('1 headings · 3 blocks · 1 variables')).toBeInTheDocument();
    // Not previewed yet → publish locked; the pill counts the failing check.
    expect(screen.getByRole('button', { name: /1 issue before publishing/ })).toBeInTheDocument();
    const publish = screen.getByRole('button', { name: 'Publish v3…' });
    expect(publish).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(publish);
    expect(screen.getByRole('tab', { name: /Checks/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Previewed after the last save')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /Publish v3/ })).toBeNull();
  });

  it('preview saves the edited draft first, then publish unlocks and publishes', async () => {
    const d = detail(version('d3', 3, 'DRAFT', DRAFT_BODY));
    mockApi(d);
    const update = vi.spyOn(documentTemplatesApi, 'updateDraft').mockResolvedValue(version('d3', 3, 'DRAFT', DRAFT_BODY));
    const preview = vi.spyOn(documentTemplatesApi, 'preview').mockResolvedValue({
      title: 'Offer of employment',
      blocks: [],
      html: '<h2>Offer</h2><p>Dear <span data-sample="talent.first_name">Amina</span>, welcome.</p>',
      sample_values: [],
    });
    const publish = vi.spyOn(documentTemplatesApi, 'publish').mockResolvedValue(version('d3', 3, 'ACTIVE', DRAFT_BODY));
    renderStudio(MANAGE);
    const title = await screen.findByDisplayValue('Offer of employment');
    fireEvent.change(title, { target: { value: 'Offer of employment 2026' } });
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByRole('article', { name: 'Page 1' });
    expect(update).toHaveBeenCalledTimes(1);
    const body = update.mock.calls[0]?.[1] as { field_schema: { title: string; html: string } };
    expect(body.field_schema.title).toBe('Offer of employment 2026');
    expect(body.field_schema.html).toBe(DRAFT_BODY);
    expect(update.mock.invocationCallOrder[0] ?? 0).toBeLessThan(preview.mock.invocationCallOrder[0] ?? 0);
    expect(within(screen.getByRole('article', { name: 'Page 1' })).getByText('Amina')).toBeInTheDocument();
    expect(screen.getByText('1 page · A4')).toBeInTheDocument();

    const pub = screen.getByRole('button', { name: 'Publish v3…' });
    expect(pub).toHaveAttribute('aria-disabled', 'false');
    fireEvent.click(pub);
    const dialog = await screen.findByRole('dialog', { name: 'Publish v3 of Offer letter' });
    expect(within(dialog).getByText(/v3 becomes the platform default/)).toBeInTheDocument();
    expect(within(dialog).getByText('v2 published')).toBeInTheDocument();
    expect(within(dialog).getByText('Variables')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish v3' }));
    await waitFor(() => expect(publish).toHaveBeenCalledWith('d3'));
    expect(await screen.findByText('v3 published. Tenants now get this version.')).toBeInTheDocument();
  });

  it('removing an unknown variable from Checks clears the required failure', async () => {
    mockApi(detail(version('d3', 3, 'DRAFT', '<p>Hi <span data-field="offer.ghost"></span></p>')));
    renderStudio(MANAGE);
    await screen.findByRole('textbox', { name: 'Paragraph' });
    expect(document.querySelector('.pws-chip--unknown')).not.toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /Checks/ }));
    expect(screen.getByText('Unknown variable {{offer.ghost}}')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove from draft' }));
    expect(screen.queryByText('Unknown variable {{offer.ghost}}')).toBeNull();
    expect(document.querySelector('.pws-chip--unknown')).toBeNull();
    expect(screen.getByText('Removed {{offer.ghost}} from the draft.')).toBeInTheDocument();
  });

  it('"/" on an empty block opens the slash menu; picking Heading turns it into a heading', async () => {
    mockApi(detail(version('d3', 3, 'DRAFT', DRAFT_BODY)));
    renderStudio(MANAGE);
    await screen.findByRole('textbox', { name: 'Heading' });
    const empty = blockEls()[2] as HTMLElement;
    expect(empty.textContent).toBe('');
    fireEvent.keyDown(empty, { key: '/' });
    const menu = screen.getByRole('menu', { name: 'Blocks' });
    expect(within(menu).getByRole('menuitem', { name: /Subheading \(H3\)/ })).toHaveAttribute('aria-disabled', 'true');
    expect(within(menu).getByRole('menuitem', { name: /Table/ })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.mouseDown(within(menu).getByRole('menuitem', { name: /^Heading/ }));
    expect(screen.queryByRole('menu', { name: 'Blocks' })).toBeNull();
    expect(blockEls()[2]).toHaveAttribute('data-kind', 'h2');
    expect(screen.getByText('2 headings · 3 blocks · 1 variables')).toBeInTheDocument();
  });

  it('"/" on a block with text types normally (no menu)', async () => {
    mockApi(detail(version('d3', 3, 'DRAFT', DRAFT_BODY)));
    renderStudio(MANAGE);
    await screen.findByRole('textbox', { name: 'Heading' });
    fireEvent.keyDown(blockEls()[1] as HTMLElement, { key: '/' });
    expect(screen.queryByRole('menu', { name: 'Blocks' })).toBeNull();
  });

  it('"{{" opens the variable popover at the caret; Enter replaces the braces with the first chip', async () => {
    mockApi(detail(version('d3', 3, 'DRAFT', DRAFT_BODY)));
    renderStudio(MANAGE);
    await screen.findByRole('textbox', { name: 'Heading' });
    const el = blockEls()[2] as HTMLElement;
    const text = document.createTextNode('Hello {{');
    el.appendChild(text);
    fireEvent.input(el);
    const r = document.createRange();
    r.setStart(text, text.length);
    r.collapse(true);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(r);
    fireEvent.keyUp(el, { key: '{' });
    const pop = screen.getByRole('dialog', { name: 'Insert variable' });
    const q = within(pop).getByRole('textbox', { name: 'Search variables' });
    fireEvent.change(q, { target: { value: 'full' } });
    expect(within(pop).getAllByRole('button')).toHaveLength(1);
    fireEvent.keyDown(q, { key: 'Enter' });
    expect(screen.queryByRole('dialog', { name: 'Insert variable' })).toBeNull();
    const chip = el.querySelector('[data-field]');
    expect(chip?.getAttribute('data-field')).toBe('talent.full_name');
    expect(el.textContent).not.toContain('{{ ');
    expect(el.textContent?.startsWith('Hello {{talent.full_name}}')).toBe(true);
    expect(screen.getByText('1 headings · 3 blocks · 2 variables')).toBeInTheDocument();
  });

  it('Enter splits a paragraph and Backspace removes an empty block', async () => {
    mockApi(detail(version('d3', 3, 'DRAFT', DRAFT_BODY)));
    renderStudio(MANAGE);
    await screen.findByRole('textbox', { name: 'Heading' });
    const p = blockEls()[1] as HTMLElement;
    caretAtEnd(p);
    fireEvent.keyDown(p, { key: 'Enter' });
    expect(blockEls()).toHaveLength(4);
    const fresh = blockEls()[2] as HTMLElement;
    fireEvent.keyDown(fresh, { key: 'Backspace' });
    expect(blockEls()).toHaveLength(3);
  });

  it('⌥↓ moves a block down and the block menu duplicates / deletes', async () => {
    mockApi(detail(version('d3', 3, 'DRAFT', DRAFT_BODY)));
    renderStudio(MANAGE);
    await screen.findByRole('textbox', { name: 'Heading' });
    fireEvent.keyDown(blockEls()[0] as HTMLElement, { key: 'ArrowDown', altKey: true });
    expect(blockEls()[1]).toHaveAttribute('data-kind', 'h2');
    fireEvent.click(screen.getAllByRole('button', { name: 'Block options' })[0] as HTMLElement);
    const menu = screen.getByRole('menu', { name: 'Block options' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Duplicate' }));
    expect(blockEls()).toHaveLength(4);
    fireEvent.click(screen.getAllByRole('button', { name: 'Block options' })[0] as HTMLElement);
    fireEvent.click(within(screen.getByRole('menu', { name: 'Block options' })).getByRole('menuitem', { name: 'Delete block' }));
    expect(blockEls()).toHaveLength(3);
  });

  it('drags an outline row onto another block to reorder', async () => {
    mockApi(detail(version('d3', 3, 'DRAFT', DRAFT_BODY)));
    renderStudio(MANAGE);
    await screen.findByRole('textbox', { name: 'Heading' });
    const rows = document.querySelectorAll<HTMLElement>('.pws-orow__btn');
    const targetRow = document.querySelectorAll<HTMLElement>('.pws-row')[2] as HTMLElement;
    fireEvent.dragStart(rows[0] as HTMLElement, { dataTransfer: { setData: () => undefined } });
    expect(screen.getByText('Drop here to add at the end')).toBeInTheDocument();
    fireEvent.dragOver(targetRow, { clientY: 10 });
    fireEvent.drop(targetRow);
    expect(blockEls().map((e) => e.getAttribute('data-kind'))).toEqual(['p', 'p', 'h2']);
  });

  it('drags a variable card onto a block to append its chip', async () => {
    mockApi(detail(version('d3', 3, 'DRAFT', DRAFT_BODY)));
    renderStudio(MANAGE);
    await screen.findByRole('textbox', { name: 'Heading' });
    const card = screen.getByText('talent.full_name').closest('.pws-vcard') as HTMLElement;
    fireEvent.dragStart(card, { dataTransfer: { setData: () => undefined } });
    const row = document.querySelectorAll<HTMLElement>('.pws-row')[1] as HTMLElement;
    fireEvent.dragOver(row, { clientY: 10 });
    fireEvent.drop(row);
    expect(blockEls()[1]?.querySelectorAll('[data-field]')).toHaveLength(2);
  });

  it('withdraws with the default 7-day notice and a required reason', async () => {
    mockApi(detail(version('d3', 3, 'DRAFT', DRAFT_BODY)));
    const withdraw = vi.spyOn(documentTemplatesApi, 'withdraw').mockResolvedValue({ ...detail(null), withdraw_effective_at: '2026-10-31T00:00:00.000Z' });
    renderStudio(MANAGE);
    await screen.findByRole('textbox', { name: 'Heading' });
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Withdraw template…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Withdraw Offer letter' });
    expect(within(dialog).getByRole('spinbutton', { name: /Notice period/ })).toHaveValue(7);
    const commit = within(dialog).getByRole('button', { name: 'Withdraw template' });
    expect(commit).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Reason/ }), { target: { value: 'Replaced by country agreements.' } });
    expect(commit).not.toBeDisabled();
    fireEvent.click(commit);
    await waitFor(() => expect(withdraw).toHaveBeenCalledWith('t1', { notice_days: 7, reason: 'Replaced by country agreements.' }));
  });

  it('shows the pending withdrawal bar with Cancel withdrawal', async () => {
    mockApi(detail(null, { withdraw_notice_at: '2026-10-20T00:00:00.000Z', withdraw_effective_at: '2099-01-01T00:00:00.000Z' }));
    const cancel = vi.spyOn(documentTemplatesApi, 'cancelWithdrawal').mockResolvedValue(detail(null));
    renderStudio(MANAGE);
    const bar = await screen.findByText('Withdrawal pending.');
    fireEvent.click(within(bar.parentElement as HTMLElement).getByRole('button', { name: 'Cancel withdrawal' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel withdrawal' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel withdrawal' }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith('t1'));
  });

  it('compares a version with the draft and restores a version into the draft', async () => {
    mockApi(detail(version('d3', 3, 'DRAFT', DRAFT_BODY)));
    renderStudio(MANAGE);
    await screen.findByRole('textbox', { name: 'Heading' });
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    const cmp = await screen.findByRole('dialog', { name: 'Compare versions' });
    expect(cmp.querySelector('.pws-cmp__stat--chg')).toHaveTextContent('1 Changed');
    expect(cmp.querySelector('.pws-cmp__stat--add')).toHaveTextContent('1 Added');
    fireEvent.click(within(cmp).getByRole('button', { name: 'Close' }));

    fireEvent.click(screen.getByRole('tab', { name: 'Versions' }));
    fireEvent.click(screen.getByRole('button', { name: /^v1/ }));
    expect(screen.getByText('Viewing v1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Restore into draft…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Restore v1 into the draft' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace draft' }));
    await screen.findByText('Draft replaced with v1. Save and preview before publishing.');
    expect(blockEls()).toHaveLength(1);
  });

  it('autosaves 3 seconds after the last edit', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockApi(detail(version('d3', 3, 'DRAFT', DRAFT_BODY)));
      const update = vi.spyOn(documentTemplatesApi, 'updateDraft').mockResolvedValue(version('d3', 3, 'DRAFT', DRAFT_BODY));
      renderStudio(MANAGE);
      const title = await screen.findByDisplayValue('Offer of employment');
      fireEvent.change(title, { target: { value: 'A' } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(update).not.toHaveBeenCalled();
      fireEvent.change(title, { target: { value: 'AB' } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100);
      });
      expect(update).toHaveBeenCalledTimes(1);
      expect(await screen.findByText(/^Autosaved · /)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('⌘S saves an existing template with no draft by creating the draft', async () => {
    mockApi(detail(null));
    const create = vi.spyOn(documentTemplatesApi, 'createDraft').mockResolvedValue(version('d3', 3, 'DRAFT', DRAFT_BODY));
    renderStudio(MANAGE);
    const title = await screen.findByDisplayValue('Offer of employment');
    fireEvent.change(title, { target: { value: 'New title' } });
    fireEvent.keyDown(document, { key: 's', metaKey: true });
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Draft saved.')).toBeInTheDocument();
  });
});

describe('TemplateStudio (:read)', () => {
  it('shows the published version in Preview only, with the view-only bar', async () => {
    mockApi(detail(version('d3', 3, 'DRAFT', DRAFT_BODY)));
    const preview = vi.spyOn(documentTemplatesApi, 'preview');
    renderStudio(READ);
    expect(await screen.findByText(/You're seeing the published version/)).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Page 1' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Publish/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled();
    expect(screen.queryByRole('textbox', { name: 'Heading' })).toBeNull();
    // TEMPLATE-STUDIO-1 (acceptance §11 item 3): only the gallery source hides these.
    expect(screen.getByRole('group', { name: 'Mode' })).toBeInTheDocument();
    expect(screen.getByTitle('Publishing checks')).toBeInTheDocument();
    expect(within(screen.getByRole('complementary', { name: 'Inspector' })).getByRole('tab', { name: /Checks/ })).toBeInTheDocument();
    expect(preview).not.toHaveBeenCalled();
  });
});
