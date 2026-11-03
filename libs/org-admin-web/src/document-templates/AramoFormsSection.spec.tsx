import { ToastProvider, type Session } from '@aramo/fe-foundation';
import type { TenantFixedForm } from '@aramo/document-templates-web';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { AramoFormsSection } from './AramoFormsSection';

// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) §7.3 — Aramo fixed forms in Our
// templates: "Aramo form · read-only", Preview for everyone, Hide / Show for document_template:
// manage only; no section when there is no form.

function session(scopes: readonly string[]): Session {
  return { sub: 'user-1', consumer_type: 'org', tenant_id: 'tenant-abc', scopes: [...scopes], iat: 0, exp: 0 };
}
const ADMIN = session(['document_template:read', 'document_template:manage']);
const READER = session(['document_template:read']);

const FORM: TenantFixedForm = {
  id: 'form-i9',
  name: 'Form I-9',
  description: null,
  document_type: { id: 'type-i9', key: 'I9', name: 'Form I-9', category: 'Employment' },
  products: ['sign'],
  version_id: 'v1',
  version_number: 2,
  updated_at: '2026-11-02T00:00:00.000Z',
  withdraw_effective_at: null,
  page_count: 4,
  hidden: false,
};

function renderSection(s: Session, listFn = vi.fn(async () => [FORM] as readonly TenantFixedForm[]), setHiddenFn = vi.fn(async (_id: string, hidden: boolean) => ({ ...FORM, hidden }))) {
  render(
    <ToastProvider>
      <MemoryRouter>
        <AramoFormsSection session={s} listFn={listFn} setHiddenFn={setHiddenFn} />
      </MemoryRouter>
    </ToastProvider>,
  );
  return { listFn, setHiddenFn };
}

describe('AramoFormsSection (§7.3)', () => {
  it('lists each form read-only with Preview; an admin can hide it and show it again', async () => {
    const { setHiddenFn } = renderSection(ADMIN);
    const row = await screen.findByTestId('aramo-form-form-i9');
    expect(row).toHaveTextContent('Aramo form · read-only');
    expect(row).toHaveTextContent('Sign');
    expect(row).toHaveTextContent('v2');
    expect(row).toHaveTextContent('Shown');
    expect(screen.getByRole('link', { name: 'Preview Form I-9' })).toHaveAttribute('href', '/org/document-templates/forms/form-i9');
    fireEvent.click(screen.getByRole('button', { name: 'Hide Form I-9' }));
    await waitFor(() => expect(setHiddenFn).toHaveBeenCalledWith('form-i9', true));
    expect(await screen.findByText('Hidden')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show Form I-9' }));
    await waitFor(() => expect(setHiddenFn).toHaveBeenCalledWith('form-i9', false));
  });

  it('a reader sees the form and Preview, never Hide / Show', async () => {
    renderSection(READER);
    await screen.findByTestId('aramo-form-form-i9');
    expect(screen.queryByRole('button', { name: /Hide|Show/ })).toBeNull();
  });

  it('no form (or a failed read) renders no section', async () => {
    const { listFn } = renderSection(ADMIN, vi.fn(async () => Promise.reject(new Error('down'))));
    await waitFor(() => expect(listFn).toHaveBeenCalled());
    expect(screen.queryByTestId('aramo-forms')).toBeNull();
  });
});
