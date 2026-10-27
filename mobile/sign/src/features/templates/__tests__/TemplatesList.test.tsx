// Templates screen (M-A4 §6.4): lists what the backend returns; Use asks for the sender
// values, creates the draft from the template and opens the Send flow at step 2. A
// template WITH signing roles (M-A6 §3.5) is bound role by role first.
import { ApiError } from '../../../api/errors';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import type { AppServices } from '../../../app/services';
import { ServicesProvider } from '../../../app/ServicesContext';
import { TemplatesList } from '../TemplatesList';
import { FEATURE_UNAVAILABLE } from '../templatesModel';

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({ navigate: mockNavigate }),
}));

const TEMPLATE = {
  template_id: '6f1c2c1e-3a51-4b44-9a3e-1f0f6a1d2b3c',
  name: 'Right to represent',
  description: null,
  document_type: { id: 'dt1', key: 'rtr', name: 'RTR' },
  version_number: 4,
  variables: [{ key: 'talent.full_name', label: 'Talent name', source: 'SENDER', value: null }],
};

const ROLE_TEMPLATE = {
  template_id: '0b6c1f9e-1d2a-4c3b-8e7f-5a4b3c2d1e0f',
  name: 'Consulting agreement',
  description: 'Two-party consulting agreement.',
  document_type: { id: 'dt2', key: 'csa', name: 'Consulting' },
  version_number: 2,
  variables: [],
  category: 'Consulting',
  signer_role_count: 1,
  cc_role_count: 1,
  document_count: 1,
  routing_mode: 'PARALLEL',
  signing: {
    routing_mode: 'PARALLEL',
    default_message: 'Please sign.',
    roles: [
      { role_key: 'consultant', label: 'Consultant', kind: 'SIGNER', order: 1 },
      { role_key: 'hr', label: 'HR', kind: 'CC', order: 2 },
    ],
  },
};

const ROLE_CONTEXT = {
  features: { templates: true },
  permissions: { templates: true },
  user: { email: 'priya@northwind.test', display_name: 'Priya Nair' },
};

let qc: QueryClient;
afterEach(() => qc?.clear());

function renderList(
  context: unknown,
  call: jest.Mock,
  opts: { items?: unknown[]; fromTemplate?: (body: Record<string, unknown>) => unknown } = {},
) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  call.mockImplementation(async (path: string, _method: string, init: { body?: unknown }) => {
    if (path === '/v1/sign/sender/context') return context;
    if (path === '/v1/sign/sender/templates') return { items: opts.items ?? [TEMPLATE], unavailable: [] };
    if (path === '/v1/sign/sender/envelopes/from-template') {
      if (opts.fromTemplate) return opts.fromTemplate(init.body as Record<string, unknown>);
      expect(init.body).toMatchObject({ template_id: TEMPLATE.template_id, values: { 'talent.full_name': 'Dana Lee' } });
      // A template without roles keeps the single-signer path: no role binding is sent.
      expect(init.body).not.toHaveProperty('recipients');
      expect(init.body).not.toHaveProperty('routing_mode');
      return { envelope: { id: 'env-1', revision: 1, status: 'DRAFT', documents: [], signers: [], fields: [] } };
    }
    throw new Error(`unexpected ${path}`);
  });
  const services = { workspace: { call } } as unknown as AppServices;
  return render(
    <ServicesProvider services={services}>
      <QueryClientProvider client={qc}>
        <TemplatesList />
      </QueryClientProvider>
    </ServicesProvider>,
  );
}

beforeEach(() => mockNavigate.mockReset());

describe('Templates screen', () => {
  it('lists returned templates with their metadata and opens step 2 after Use', async () => {
    const call = jest.fn();
    renderList({ features: { templates: true }, permissions: { templates: true } }, call);
    expect(await screen.findByText('Right to represent')).toBeTruthy();
    expect(screen.getByText('RTR · Version 4')).toBeTruthy();
    expect(screen.queryByText('Who fills each role?')).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByTestId('template-0'));
    });
    // A template without roles: the sender-variable form, no role cards.
    expect(screen.queryByText('Who fills each role?')).toBeNull();
    fireEvent.changeText(screen.getByLabelText('Talent name'), 'Dana Lee');
    await act(async () => {
      fireEvent.press(screen.getByText('Use template'));
    });
    expect(mockNavigate).toHaveBeenCalledWith('SendFlow', { envelopeId: 'env-1', step: 'recipients' });
  });

  it('shows the reason when templates are not available, without calling the route', async () => {
    const call = jest.fn();
    renderList({ features: { templates: false }, permissions: { templates: true } }, call);
    expect(await screen.findByText(FEATURE_UNAVAILABLE)).toBeTruthy();
    expect(call.mock.calls.map((c) => c[0])).toEqual(['/v1/sign/sender/context']);
  });

  it('binds roles for a template with roles and opens Review when everything is bound', async () => {
    const call = jest.fn();
    const sent: Record<string, unknown>[] = [];
    renderList(ROLE_CONTEXT, call, {
      items: [ROLE_TEMPLATE],
      fromTemplate: (body) => {
        sent.push(body);
        return {
          envelope: {
            id: 'env-2',
            revision: 1,
            status: 'DRAFT',
            documents: [{ id: 'd1', title: 'Consulting agreement' }],
            recipients: [{ id: 'r1', name: 'Priya Nair', email: 'priya@northwind.test', signing_order: 1 }],
            fields: [{ id: 'f1', envelope_document_id: 'd1', signer_id: 'r1', field_type: 'SIGNATURE', page_number: 1, x: 1, y: 1 }],
          },
        };
      },
    });
    expect(await screen.findByText('Consulting · 1 signer · 1 document · 1 copy')).toBeTruthy();
    expect(screen.getByText('Two-party consulting agreement.')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('template-0'));
    });
    expect(screen.getByText('Who fills each role?')).toBeTruthy();
    expect(screen.getByText('Consultant · Signer')).toBeTruthy();
    expect(screen.getByText('HR · Gets a copy · Optional')).toBeTruthy();
    expect(screen.getByDisplayValue('Please sign.')).toBeTruthy();
    // Nothing bound yet: the client check names the missing role and sends nothing.
    await act(async () => {
      fireEvent.press(screen.getByTestId('role-use'));
    });
    expect(screen.getByText('Choose a person for Consultant.')).toBeTruthy();
    expect(sent).toHaveLength(0);
    // Assign to me is offered for the SIGNER role only.
    expect(screen.queryByTestId('role-1-me')).toBeNull();
    fireEvent.press(screen.getByTestId('role-0-me'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('role-use'));
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      template_id: ROLE_TEMPLATE.template_id,
      recipients: [{ role_key: 'consultant', name: 'Priya Nair', email: 'priya@northwind.test' }],
      routing_mode: 'PARALLEL',
      message: 'Please sign.',
    });
    expect(sent[0]).not.toHaveProperty('signer');
    expect(sent[0]).not.toHaveProperty('cc');
    expect(mockNavigate).toHaveBeenCalledWith('SendFlow', { envelopeId: 'env-2', step: 'review' });
  });

  it('shows the server reason and reloads the list when the roles changed', async () => {
    const call = jest.fn();
    renderList(ROLE_CONTEXT, call, {
      items: [ROLE_TEMPLATE],
      fromTemplate: () => {
        throw new ApiError({ status: 409, code: 'TEMPLATE_VERSION_NOT_ACTIVE', reason: 'template_roles_changed' });
      },
    });
    await screen.findByText('Consulting agreement');
    await act(async () => {
      fireEvent.press(screen.getByTestId('template-0'));
    });
    fireEvent.press(screen.getByTestId('role-0-me'));
    const listCalls = () => call.mock.calls.filter((c) => c[0] === '/v1/sign/sender/templates').length;
    const before = listCalls();
    await act(async () => {
      fireEvent.press(screen.getByTestId('role-use'));
    });
    expect(await screen.findByText(/This template changed while you were filling it in/)).toBeTruthy();
    expect(listCalls()).toBeGreaterThan(before);
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
