import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { EmailTemplatePreview, EmailTemplateView } from '../communications/email-templates-api';

import { EmailTemplatesPanel } from './EmailTemplatesPanel';

// D-EMAIL-TPL-1 (ET-6) — Settings template-management surface. RBAC mirrors the
// server (read → view/preview; manage → mutation). D-1: the system default is
// read-only; "Create override" is a create (POST), never a mutate of the default.

function makeSession(scopes: string[]): Session {
  return { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't1', scopes, iat: 0, exp: 0 };
}

const READ = ['communication:template:read'];
const MANAGE = ['communication:template:read', 'communication:template:manage'];

function systemDefault(over: Partial<EmailTemplateView> = {}): EmailTemplateView {
  return {
    id: null,
    template_key: 'requisition-contact',
    category: 'requisition_initial_contact',
    name: 'Recruiter initial contact',
    subject_template: 'Hi {{talent.first_name}}',
    body_template: 'About {{requisition.title}}',
    is_system_default: true,
    is_active: true,
    updated_at: null,
    ...over,
  };
}

function tenantOverride(over: Partial<EmailTemplateView> = {}): EmailTemplateView {
  return {
    id: 'row-1',
    template_key: 'requisition-contact',
    category: 'requisition_initial_contact',
    name: 'Our custom email',
    subject_template: 'Hello {{talent.first_name}}',
    body_template: 'Re {{requisition.title}} at {{company.name}}',
    is_system_default: false,
    is_active: true,
    updated_at: '2026-09-29T00:00:00.000Z',
    ...over,
  };
}

interface Fns {
  listFn?: () => Promise<readonly EmailTemplateView[]>;
  createFn?: (input: unknown) => Promise<EmailTemplateView>;
  updateFn?: (id: string, input: unknown) => Promise<EmailTemplateView>;
  deactivateFn?: (id: string) => Promise<void>;
  previewFn?: (id: string, input: unknown) => Promise<EmailTemplatePreview>;
}

function renderPanel(scopes: string[], fns: Fns = {}) {
  return render(
    <ToastProvider>
      <EmailTemplatesPanel
        sessionOverride={makeSession(scopes)}
        listFn={fns.listFn}
        createFn={fns.createFn as never}
        updateFn={fns.updateFn as never}
        deactivateFn={fns.deactivateFn as never}
        previewFn={fns.previewFn as never}
      />
    </ToastProvider>,
  );
}

describe('EmailTemplatesPanel (ET-6)', () => {
  it('read scope → view + preview only, NO mutation controls', async () => {
    const listFn = vi.fn().mockResolvedValue([systemDefault()]);
    renderPanel(READ, { listFn });
    expect(await screen.findByText(/System default \(read-only\)/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview' })).toBeInTheDocument();
    // manage-only controls are absent
    expect(screen.queryByRole('button', { name: 'Create override' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reset to default' })).toBeNull();
  });

  it('no read scope → access note, no fetch, no controls', async () => {
    const listFn = vi.fn().mockResolvedValue([systemDefault()]);
    renderPanel([], { listFn });
    expect(await screen.findByText(/don’t have permission/i)).toBeInTheDocument();
    expect(listFn).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull();
  });

  it('system default is visibly read-only; manage exposes "Create override" (create, not mutate)', async () => {
    const listFn = vi
      .fn()
      .mockResolvedValueOnce([systemDefault()])
      .mockResolvedValue([tenantOverride()]);
    const createFn = vi.fn().mockResolvedValue(tenantOverride());
    const updateFn = vi.fn();
    renderPanel(MANAGE, { listFn, createFn, updateFn });

    expect(await screen.findByText(/System default \(read-only\)/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create override' }));

    // editor opens; edit the subject and save
    const subject = await screen.findByLabelText('Subject');
    fireEvent.change(subject, { target: { value: 'Hello {{talent.first_name}}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(createFn).toHaveBeenCalledTimes(1));
    // D-1: creating an override never mutates the system default
    expect(updateFn).not.toHaveBeenCalled();
    expect(createFn.mock.calls[0]![0]).toMatchObject({
      category: 'requisition_initial_contact',
      subject_template: 'Hello {{talent.first_name}}',
    });
  });

  it('tenant override is visibly identified; edit issues an update (PATCH)', async () => {
    const listFn = vi.fn().mockResolvedValue([tenantOverride()]);
    const updateFn = vi.fn().mockResolvedValue(tenantOverride());
    renderPanel(MANAGE, { listFn, updateFn });

    expect(await screen.findByText('Tenant override')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(await screen.findByLabelText('Subject'), {
      target: { value: 'Updated {{requisition.title}}' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateFn).toHaveBeenCalledTimes(1));
    expect(updateFn.mock.calls[0]![0]).toBe('row-1');
  });

  it('reset/deactivate → effective view falls back to the system default', async () => {
    const listFn = vi
      .fn()
      .mockResolvedValueOnce([tenantOverride()])
      .mockResolvedValue([systemDefault()]);
    const deactivateFn = vi.fn().mockResolvedValue(undefined);
    renderPanel(MANAGE, { listFn, deactivateFn });

    expect(await screen.findByText('Tenant override')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }));

    await waitFor(() => expect(deactivateFn).toHaveBeenCalledWith('row-1'));
    expect(await screen.findByText(/System default \(read-only\)/i)).toBeInTheDocument();
    expect(screen.queryByText('Tenant override')).toBeNull();
  });

  it('preview renders server output (read scope)', async () => {
    const listFn = vi.fn().mockResolvedValue([systemDefault()]);
    const previewFn = vi.fn().mockResolvedValue({
      subject: 'Hi Omvignesh',
      body: 'About Business Analyst',
      warnings: [],
    } satisfies EmailTemplatePreview);
    renderPanel(READ, { listFn, previewFn });

    fireEvent.click(await screen.findByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(previewFn).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/About Business Analyst/)).toBeInTheDocument();
  });

  it('shows the allowed merge-field reference', async () => {
    const listFn = vi.fn().mockResolvedValue([systemDefault()]);
    renderPanel(READ, { listFn });
    expect(await screen.findByText('{{talent.first_name}}')).toBeInTheDocument();
    expect(screen.getByText('{{company.name}}')).toBeInTheDocument();
  });
});
