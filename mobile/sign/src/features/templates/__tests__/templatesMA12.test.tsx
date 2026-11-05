// M-A12 W1-F — Templates: search, My / Shared tabs (from the server's ownership),
// favorites (star), and the Personal Free prompt with View plans (no "organization").
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import type { AppServices } from '../../../app/services';
import { ServicesProvider } from '../../../app/ServicesContext';
import { ToastProvider } from '../../../components/Toast';
import { TemplatesList } from '../TemplatesList';
import { PERSONAL_TEMPLATES_PROMPT } from '../templatesModel';

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({ navigate: mockNavigate }),
}));

const WAIT = { timeout: 10_000 } as const;
jest.setTimeout(30_000);

const tpl = (id: string, name: string, ownership: 'mine' | 'shared', favorite = false) => ({
  template_id: id,
  name,
  description: null,
  document_type: { id: 'dt', key: 'k', name: 'Agreement' },
  version_number: 1,
  variables: [],
  ownership,
  favorite,
});

let qc: QueryClient;
afterEach(() => qc?.clear());
beforeEach(() => mockNavigate.mockReset());

function renderList(context: unknown, items: unknown[] = []) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const call = jest.fn(async (path: string) => {
    if (path === '/v1/sign/sender/context') return context;
    if (path === '/v1/sign/sender/templates') return { items, unavailable: [] };
    throw new Error(`unexpected ${path}`);
  });
  const request = jest.fn(async () => ({ status: 204, data: undefined, etag: null }));
  const services = { workspace: { call, request } } as unknown as AppServices;
  render(
    <ServicesProvider services={services}>
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <TemplatesList />
        </ToastProvider>
      </QueryClientProvider>
    </ServicesProvider>,
  );
  return { call, request };
}

const ORG = { features: { templates: true }, permissions: { templates: true }, tenant: { kind: 'BUSINESS' } };

describe('Templates (M-A12 W1-F)', () => {
  it('Personal Free: the Standard prompt and View plans, never organization wording', async () => {
    renderList({ features: { templates: false }, permissions: { templates: false }, tenant: { kind: 'PERSONAL' } });
    expect(await screen.findByText(PERSONAL_TEMPLATES_PROMPT, undefined, WAIT)).toBeTruthy();
    expect(screen.queryByText(/organization/i)).toBeNull();
    fireEvent.press(screen.getByTestId('templates-view-plans'));
    expect(mockNavigate).toHaveBeenCalledWith('Plans', { from: 'templates' });
  });

  it('search and My / Shared tabs from the server ownership', async () => {
    renderList(ORG, [tpl('a', 'Offer letter', 'mine'), tpl('b', 'NDA', 'shared'), tpl('c', 'Offer extension', 'shared')]);
    expect(await screen.findByText('Offer letter', undefined, WAIT)).toBeTruthy();
    expect(screen.queryByText('NDA')).toBeNull();
    fireEvent.press(screen.getByTestId('templates-tab-shared'));
    expect(screen.getByText('NDA')).toBeTruthy();
    fireEvent.changeText(screen.getByTestId('templates-search'), 'offer');
    expect(screen.queryByText('NDA')).toBeNull();
    expect(screen.getByText('Offer extension')).toBeTruthy();
  });

  it('the star saves a favorite (PUT) and favorites list first', async () => {
    const { request } = renderList(ORG, [tpl('a', 'Alpha', 'mine'), tpl('b', 'Beta', 'mine', true)]);
    expect(await screen.findByText('Alpha', undefined, WAIT)).toBeTruthy();
    expect(screen.getByTestId('template-star-0').props.accessibilityLabel).toBe('Remove Beta from favorites');
    await act(async () => {
      fireEvent.press(screen.getByTestId('template-star-1'));
    });
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({ method: 'PUT', path: '/v1/sign/templates/a/favorite' }),
    );
  });
});
