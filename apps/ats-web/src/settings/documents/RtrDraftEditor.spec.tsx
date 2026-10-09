import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { RtrDraftEditor } from './RtrDraftEditor';
import {
  RIGHT_TO_REPRESENT_TYPE_ID,
  type DocumentTemplateView,
  type TemplateBinding,
  type TemplateVersionView,
} from './document-templates-api';

// DOC-TEMPLATE-ADMIN-RTR-1 (§11/§18/§20/§59) — the RTR draft editor. Proves: the
// Insert-field palette is the SERVER catalog (inserts only governed tokens); the §18
// gate flow (Approve disabled until the saved content has been previewed, re-armed by
// any edit); and the §20 success state after approval.

function makeSession(scopes: readonly string[]): Session {
  return { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't1', scopes: [...scopes], iat: 0, exp: 0 };
}
const MANAGER = makeSession(['document_template:read', 'document_template:manage']);

const RTR_TEMPLATE: DocumentTemplateView = {
  id: 'tpl-rtr',
  tenant_id: 't1',
  document_type_id: RIGHT_TO_REPRESENT_TYPE_ID,
  client_id: null,
  name: 'Right to Represent',
  description: null,
  template_kind: 'GENERATED',
  status: 'ACTIVE',
  current_version_id: 'v1',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const DRAFT: TemplateVersionView = {
  id: 'v2',
  tenant_id: 't1',
  template_id: 'tpl-rtr',
  version_number: 2,
  status: 'DRAFT',
  render_schema_version: 'rtr-generated-v1',
  field_schema: { render_schema_version: 'rtr-generated-v1', title: 'RTR', blocks: [{ type: 'TEXT', text: 'Hello ' }] },
  binding_schema: null,
  created_by: 'u1',
  created_at: '2026-01-01T00:00:00.000Z',
  activated_at: null,
  activated_by: null,
  retired_at: null,
  // Not yet previewed: content_fingerprint set, previewed null → gate armed.
  content_fingerprint: 'fp',
  previewed_fingerprint: null,
};

const BINDINGS: readonly TemplateBinding[] = [
  { key: 'talent.full_name', label: 'Talent full name', group: 'Talent' },
  { key: 'client.name', label: 'Client name', group: 'Client' },
];

function harness(overrides: Partial<Parameters<typeof RtrDraftEditor>[0]> = {}) {
  const props = {
    sessionOverride: MANAGER,
    listTemplatesFn: () => Promise.resolve([RTR_TEMPLATE]),
    listVersionsFn: () => Promise.resolve([DRAFT]),
    listBindingsFn: () => Promise.resolve(BINDINGS),
    updateFn: vi.fn().mockResolvedValue(DRAFT),
    previewFn: vi.fn().mockResolvedValue({ title: 'RTR', blocks: [{ type: 'TEXT', text: 'Hello Ravi Shankar' }] }),
    activateFn: vi.fn().mockResolvedValue({ ...DRAFT, status: 'ACTIVE' as const }),
    ...overrides,
  };
  render(
    <ToastProvider>
      <MemoryRouter>
        <RtrDraftEditor {...props} />
      </MemoryRouter>
    </ToastProvider>,
  );
  return props;
}

describe('RtrDraftEditor (§11)', () => {
  it('renders the Insert-field palette from the server catalog (only governed fields)', async () => {
    harness();
    expect(await screen.findByTestId('rtr-binding-talent.full_name')).toHaveTextContent('Talent full name');
    expect(screen.getByTestId('rtr-binding-client.name')).toBeInTheDocument();
    // The palette is exactly the server set — no agreed-pay / free-form token.
    expect(screen.queryByTestId('rtr-binding-agreed_pay_rate.amount')).toBeNull();
  });

  it('inserting a field appends only the governed token into the focused block', async () => {
    harness();
    const block = (await screen.findByTestId('rtr-block-text-0')) as HTMLTextAreaElement;
    fireEvent.focus(block);
    fireEvent.click(screen.getByTestId('rtr-binding-talent.full_name'));
    expect(block.value).toBe('Hello {{talent.full_name}}');
  });

  it('enforces the §18 gate: Approve is disabled until a clean preview, re-armed by any edit', async () => {
    const props = harness();
    const approve = (await screen.findByTestId('rtr-editor-approve')) as HTMLButtonElement;
    // A freshly-loaded, un-previewed draft → Approve blocked.
    expect(approve).toBeDisabled();

    // Preview the (clean) content → records a preview → Approve enabled.
    fireEvent.click(screen.getByTestId('rtr-editor-preview'));
    await waitFor(() => expect(props.previewFn).toHaveBeenCalledWith('v2'));
    await waitFor(() => expect(screen.getByTestId('rtr-editor-approve')).not.toBeDisabled());
    expect(screen.getByTestId('rtr-editor-previewout')).toHaveTextContent('Hello Ravi Shankar');

    // Any edit re-arms the gate → Approve blocked again until re-previewed.
    fireEvent.change(screen.getByTestId('rtr-editor-title'), { target: { value: 'RTR v2' } });
    expect(screen.getByTestId('rtr-editor-approve')).toBeDisabled();
  });

  it('Preview saves pending edits first (preview reads the persisted content)', async () => {
    const props = harness();
    await screen.findByTestId('rtr-editor-title');
    fireEvent.change(screen.getByTestId('rtr-editor-title'), { target: { value: 'Edited' } });
    fireEvent.click(screen.getByTestId('rtr-editor-preview'));
    await waitFor(() => expect(props.updateFn).toHaveBeenCalled()); // dirty → saved before preview
    await waitFor(() => expect(props.previewFn).toHaveBeenCalledWith('v2'));
  });

  it('Approve activates then shows the §20 success state', async () => {
    const props = harness();
    fireEvent.click(await screen.findByTestId('rtr-editor-preview'));
    await waitFor(() => expect(screen.getByTestId('rtr-editor-approve')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('rtr-editor-approve'));
    await waitFor(() => expect(props.activateFn).toHaveBeenCalledWith('v2'));
    expect(await screen.findByTestId('rtr-editor-done')).toBeInTheDocument();
  });

  it('a non-manager is refused the editor', async () => {
    harness({ sessionOverride: makeSession(['document_template:read']) });
    expect(await screen.findByText(/don’t have permission/i)).toBeInTheDocument();
    expect(screen.queryByTestId('rtr-editor-approve')).toBeNull();
  });
});
