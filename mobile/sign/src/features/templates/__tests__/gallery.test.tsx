// Aramo-TEMPLATE-PRODUCT-1 §8.5 (R6-M) — the mobile "Aramo templates" section: the unadopted
// Aramo templates for Aramo Sign with "Use as it is" (one adopt-and-use call) when the backend
// offers it, "Ask an admin to approve this template" otherwise (and for the server's refusal),
// and "Adopt and edit on desktop" for every other change. Use-only: no editor.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { ApiError } from '../../../api/errors';
import type { AppServices } from '../../../app/services';
import { ServicesProvider } from '../../../app/ServicesContext';
import { ALREADY_ADOPTED, ASK_ADMIN, EDIT_ON_DESKTOP, canUseAsIs, unadoptedGallery, asIsRefusalMessage } from '../gallery';
import { TemplatesList } from '../TemplatesList';

jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({ navigate: jest.fn() }),
}));

const WAIT = { timeout: 10_000 } as const;
jest.setTimeout(30_000);

const NDA = {
  template_id: '7a1c2c1e-3a51-4b44-9a3e-1f0f6a1d2b3c',
  name: 'Mutual NDA',
  description: 'Two-way confidentiality.',
  document_type: { id: 'dt9', name: 'Non-disclosure agreement' },
  products: ['sign'],
  version_id: 'v1',
  version_number: 1,
  updated_at: '2026-11-01T00:00:00Z',
  adopted_template_id: null,
};
const ADOPTED = { ...NDA, template_id: '8b1c2c1e-3a51-4b44-9a3e-1f0f6a1d2b3c', name: 'Lease', adopted_template_id: '9c1c2c1e-3a51-4b44-9a3e-1f0f6a1d2b3c' };

let qc: QueryClient;
afterEach(() => qc?.clear());

function renderList(context: Record<string, unknown>, adoptAndUse: (id: string) => unknown) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  const call = jest.fn(async (path: string, _method: string, init: { path?: { id?: string } }) => {
    if (path === '/v1/sign/sender/context') return context;
    if (path === '/v1/sign/sender/templates') return { items: [], unavailable: [] };
    if (path === '/v1/sign/sender/templates/library') return { items: [NDA, ADOPTED] };
    if (path === '/v1/sign/sender/templates/library/{id}/adopt-and-use') return adoptAndUse(init.path?.id ?? '');
    throw new Error(`unexpected ${path}`);
  });
  const services = { workspace: { call } } as unknown as AppServices;
  render(
    <ServicesProvider services={services}>
      <QueryClientProvider client={qc}>
        <TemplatesList />
      </QueryClientProvider>
    </ServicesProvider>,
  );
  return call;
}

const CTX = { features: { templates: true }, permissions: { templates: true } };

describe('Aramo templates (Use as it is)', () => {
  it('lists only the unadopted Aramo templates, with Use as it is when the backend offers it', async () => {
    const call = renderList({ ...CTX, template_use_as_is: true }, () => ({ template: { id: 't', status: 'ACTIVE' }, version: { id: 'v', status: 'ACTIVE' } }));
    expect(await screen.findByText('Mutual NDA', undefined, WAIT)).toBeTruthy();
    expect(screen.queryByText('Lease')).toBeNull();
    expect(screen.getByText(EDIT_ON_DESKTOP)).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('use-as-is-0'));
    });
    await waitFor(() => expect(call.mock.calls.some((c) => c[0] === '/v1/sign/sender/templates/library/{id}/adopt-and-use' && (c[2] as { path: { id: string } }).path.id === NDA.template_id)).toBe(true), WAIT);
    expect(await screen.findByText('“Mutual NDA” is ready to use in your templates.', undefined, WAIT)).toBeTruthy();
  });

  it('without approval: "Ask an admin to approve this template", no Use as it is', async () => {
    renderList({ ...CTX, template_use_as_is: false }, () => {
      throw new Error('must not be called');
    });
    expect(await screen.findByText(ASK_ADMIN, undefined, WAIT)).toBeTruthy();
    expect(screen.queryByTestId('use-as-is-0')).toBeNull();
  });

  it('a server refusal for approval reads "Ask an admin to approve this template"', async () => {
    renderList({ ...CTX, template_use_as_is: true }, () => {
      throw new ApiError({ status: 403, code: 'INSUFFICIENT_PERMISSIONS', reason: 'template_approval_required' });
    });
    await act(async () => {
      fireEvent.press(await screen.findByTestId('use-as-is-0', undefined, WAIT));
    });
    expect(await screen.findByText(ASK_ADMIN, undefined, WAIT)).toBeTruthy();
  });
});

describe('gallery model', () => {
  it('unadoptedGallery keeps only templates without an adopted copy', () => {
    expect(unadoptedGallery({ items: [NDA, ADOPTED] })).toEqual([
      { id: NDA.template_id, name: 'Mutual NDA', documentType: 'Non-disclosure agreement', description: 'Two-way confidentiality.', versionNumber: 1 },
    ]);
    expect(unadoptedGallery(null)).toEqual([]);
  });

  it('canUseAsIs reads only the backend signal', () => {
    expect(canUseAsIs({ template_use_as_is: true })).toBe(true);
    expect(canUseAsIs({ template_use_as_is: false })).toBe(false);
    expect(canUseAsIs({})).toBe(false);
  });

  it('asIsRefusalMessage maps the server reasons', () => {
    expect(asIsRefusalMessage(new ApiError({ status: 403, code: 'INSUFFICIENT_PERMISSIONS', reason: 'template_approval_required' }))).toBe(ASK_ADMIN);
    expect(asIsRefusalMessage(new ApiError({ status: 409, code: 'VALIDATION_ERROR', reason: 'already_adopted' }))).toBe(ALREADY_ADOPTED);
  });
});
