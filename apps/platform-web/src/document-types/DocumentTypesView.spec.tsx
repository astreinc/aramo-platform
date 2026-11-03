import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApiError } from '@aramo/fe-foundation';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { platformSession } from '../skills/test-session';

import { documentTypesApi, type PlatformDocumentType } from './document-types-api';
import { DocumentTypesView, documentTypeErrorText } from './DocumentTypesView';

// TEMPLATE-PRODUCT-1 §4.4 — the Platform Admin Document types screen: the two sections, the
// System / Seeded badges, kind / products / category / templates / status, the create and
// edit dialog (only the server-listed editable fields change), retire / delete, the view-only
// note for :read.

const READ = ['platform:document_template:read'];
const MANAGE = ['platform:document_template:read', 'platform:document_template:manage'];
const ALL = ['name', 'description', 'category', 'template_kind', 'products', 'retention_class', 'execution_mode_default'];

function dt(key: string, over: Partial<PlatformDocumentType> = {}): PlatformDocumentType {
  return {
    id: `id-${key}`,
    key,
    name: key,
    description: null,
    type_class: 'TEMPLATE',
    template_kind: null,
    products: [],
    category: null,
    retention_class: 'CONTRACT_RECORD',
    execution_mode_default: 'SINGLE_SIGNATURE',
    active: true,
    system_defined: true,
    badge: 'SEEDED',
    editable_fields: ALL,
    templates_count: 0,
    live_default: false,
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
    ...over,
  };
}

const TYPES: PlatformDocumentType[] = [
  dt('RIGHT_TO_REPRESENT', { name: 'Right to Represent', badge: 'SYSTEM', template_kind: 'EDITABLE', products: ['ats', 'sign'], category: 'Recruiting', templates_count: 4, live_default: true, editable_fields: ['name', 'description', 'category', 'products'] }),
  dt('OFFER_LETTER', { name: 'Offer Letter', badge: 'SYSTEM', editable_fields: ['description'] }),
  dt('I9', { name: 'I-9' }),
  dt('MUTUAL_NDA', { name: 'Mutual NDA', badge: null, system_defined: false, template_kind: 'EDITABLE', products: ['sign'], category: 'Legal' }),
  dt('TALENT_RESUME', { name: 'Talent Resume', type_class: 'UPLOAD', retention_class: 'TALENT_DOCUMENT', editable_fields: [] }),
];

function renderView(scopes: string[]) {
  vi.spyOn(documentTypesApi, 'list').mockResolvedValue({
    document_types: TYPES,
    retention_classes: ['CONTRACT_RECORD', 'TALENT_DOCUMENT'],
    execution_modes: ['NO_SIGNATURE', 'ACKNOWLEDGEMENT', 'SINGLE_SIGNATURE', 'MULTI_SIGNATURE'],
  });
  return render(<DocumentTypesView session={platformSession(scopes)} />);
}

describe('DocumentTypesView', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lists template types (badges, kind, products, category, templates, status) and the read-only upload types', async () => {
    renderView(MANAGE);
    const rtr = await screen.findByTestId('doctype-RIGHT_TO_REPRESENT');
    expect(within(rtr).getByText('System')).toBeInTheDocument();
    expect(rtr).toHaveTextContent('Editable');
    expect(rtr).toHaveTextContent('ATSSign');
    expect(rtr).toHaveTextContent('Recruiting');
    expect(rtr).toHaveTextContent('4');
    // A system-locked type is never retired or deleted.
    expect(within(rtr).queryByRole('button', { name: /Retire|Delete/ })).toBeNull();
    expect(within(screen.getByTestId('doctype-OFFER_LETTER')).getByText('Not yet available for templates')).toBeInTheDocument();
    expect(within(screen.getByTestId('doctype-I9')).getByText('Seeded')).toBeInTheDocument();
    expect(within(screen.getByTestId('doctype-I9')).queryByRole('button', { name: 'Delete I-9' })).toBeNull();
    expect(within(screen.getByTestId('doctype-MUTUAL_NDA')).getByRole('button', { name: 'Delete Mutual NDA' })).toBeInTheDocument();
    const uploads = screen.getByRole('table', { name: 'System upload types' });
    expect(within(uploads).getByText('TALENT_RESUME')).toBeInTheDocument();
    expect(within(uploads).queryByRole('button')).toBeNull();
    expect(within(screen.getByRole('table', { name: 'Template types' })).queryByText('Talent Resume')).toBeNull();
  });

  it(':read sees the view-only note and no write controls', async () => {
    renderView(READ);
    await screen.findByTestId('doctype-I9');
    expect(screen.getByRole('note')).toHaveTextContent('View only.');
    expect(screen.queryByRole('button', { name: '+ New document type' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Edit / })).toBeNull();
  });

  it('creates a type: name, kind, products (≥1), retention, signing', async () => {
    const create = vi.spyOn(documentTypesApi, 'create').mockResolvedValue(TYPES[3] as PlatformDocumentType);
    renderView(MANAGE);
    fireEvent.click(await screen.findByRole('button', { name: '+ New document type' }));
    const dialog = await screen.findByRole('dialog', { name: 'New document type' });
    const commit = within(dialog).getByRole('button', { name: 'Create type' });
    expect(commit).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox', { name: /^Name/ }), { target: { value: 'Residential lease' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /^Category/ }), { target: { value: 'Real estate' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: /Signing/ }), { target: { value: 'MULTI_SIGNATURE' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Products Sign' }));
    fireEvent.click(within(dialog).getByRole('option', { name: 'Sign' }));
    expect(commit).toBeDisabled(); // no product
    fireEvent.click(within(dialog).getByRole('option', { name: 'ATS' }));
    expect(commit).toBeEnabled();
    fireEvent.click(commit);
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        name: 'Residential lease',
        description: null,
        category: 'Real estate',
        template_kind: 'EDITABLE',
        products: ['ats'],
        retention_class: 'CONTRACT_RECORD',
        execution_mode_default: 'MULTI_SIGNATURE',
      }),
    );
  });

  it('editing a system-locked type sends only its editable fields', async () => {
    const update = vi.spyOn(documentTypesApi, 'update').mockResolvedValue(TYPES[0] as PlatformDocumentType);
    renderView(MANAGE);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Right to Represent' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Right to Represent' });
    expect(within(dialog).getByRole('textbox', { name: 'Kind' })).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox', { name: /^Name/ }), { target: { value: 'Right to Represent (RTR)' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save type' }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('id-RIGHT_TO_REPRESENT', { name: 'Right to Represent (RTR)', description: null, category: 'Recruiting', products: ['ats', 'sign'] }),
    );
  });

  it('retire shows the server refusal; delete deletes and reloads', async () => {
    vi.spyOn(documentTypesApi, 'retire').mockRejectedValue(new ApiError(409, 'live', 'DOCUMENT_TYPE_CONFLICT', { reason: 'live_default' }));
    const remove = vi.spyOn(documentTypesApi, 'remove').mockResolvedValue(undefined);
    renderView(MANAGE);
    fireEvent.click(await screen.findByRole('button', { name: 'Retire Mutual NDA' }));
    let dialog = await screen.findByRole('dialog', { name: 'Retire Mutual NDA?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retire type' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Withdraw it before retiring the type.');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Delete Mutual NDA' }));
    dialog = await screen.findByRole('dialog', { name: 'Delete Mutual NDA?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete type' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('id-MUTUAL_NDA'));
    await waitFor(() => expect(documentTypesApi.list).toHaveBeenCalledTimes(2));
  });

  it('maps every refusal reason to operator copy', () => {
    const e = (reason: string): ApiError => new ApiError(409, 'm', 'DOCUMENT_TYPE_CONFLICT', { reason });
    expect(documentTypeErrorText(e('kind_in_use'), 'x')).toBe('Templates already use this type, so its kind can’t change.');
    expect(documentTypeErrorText(e('key_exists'), 'x')).toBe('A document type with this name already exists.');
    expect(documentTypeErrorText(new Error('boom'), 'fallback')).toBe('fallback');
  });
});
