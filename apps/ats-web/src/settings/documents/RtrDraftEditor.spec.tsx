import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

function harness(overrides: Partial<Parameters<typeof RtrDraftEditor>[0]> = {}) {
  const draft = mkVersion('v2', 2, 'DRAFT', false);
  const props = {
    sessionOverride: MANAGER,
    listTemplatesFn: () => Promise.resolve([RTR_TEMPLATE]),
    listVersionsFn: () => Promise.resolve([mkVersion('v1', 1, 'ACTIVE', true), draft]),
    listBindingsFn: () => Promise.resolve(BINDINGS),
    updateFn: vi.fn().mockResolvedValue(draft),
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

  it('a non-manager is refused the editor', async () => {
    harness({ sessionOverride: makeSession(['document_template:read']) });
    expect(await screen.findByText(/don’t have permission/i)).toBeInTheDocument();
    expect(screen.queryByTestId('rtr-editor-approve')).toBeNull();
  });
});
