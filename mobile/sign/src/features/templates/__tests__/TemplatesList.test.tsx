// Templates screen (M-A4 §6.4): lists what the backend returns; Use asks for the sender
// values, creates the draft from the template and opens the Send flow at step 2.
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

let qc: QueryClient;
afterEach(() => qc?.clear());

function renderList(context: unknown, call: jest.Mock) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  call.mockImplementation(async (path: string, _method: string, init: { body?: unknown }) => {
    if (path === '/v1/sign/sender/context') return context;
    if (path === '/v1/sign/sender/templates') return { items: [TEMPLATE], unavailable: [] };
    if (path === '/v1/sign/sender/envelopes/from-template') {
      expect(init.body).toMatchObject({ template_id: TEMPLATE.template_id, values: { 'talent.full_name': 'Dana Lee' } });
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
    expect(screen.queryByText(/role/i)).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByTestId('template-0'));
    });
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
});
