import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Branding } from '../branding-api';

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.10 — Settings → Branding. Until the
// feature is offered the page says "Coming soon" and offers no controls; a plan without branding
// points to the plans; an entitled sign_admin edits the name, colours and logo; anyone the backend
// marks can_edit=false sees it read-only.

const get = vi.fn();
const save = vi.fn();
const uploadLogo = vi.fn();
const removeLogo = vi.fn();
vi.mock('../branding-api', async (orig) => {
  const mod = await orig<typeof import('../branding-api')>();
  return {
    ...mod,
    brandingApi: {
      get: (...a: unknown[]) => get(...a),
      save: (...a: unknown[]) => save(...a),
      uploadLogo: (...a: unknown[]) => uploadLogo(...a),
      removeLogo: (...a: unknown[]) => removeLogo(...a),
    },
  };
});
const toast = vi.fn();
vi.mock('../workspace', () => ({
  useWorkspace: () => ({ base: '/sign', toast, ctx: { tenant: { id: 't', name: 'Acme', kind: 'BUSINESS' }, organization_url: null } }),
}));

import { BrandingSection } from './Branding';

const DARK: Branding = { available: false, entitled: false, can_edit: false, display_name: null, primary_color: null, accent_color: null, logo: null, updated_at: null };
const ON: Branding = { ...DARK, available: true, entitled: true, can_edit: true };

function show() {
  render(
    <MemoryRouter>
      <BrandingSection />
    </MemoryRouter>,
  );
}

afterEach(() => vi.clearAllMocks());

describe('Settings → Branding', () => {
  it('not offered yet: Coming soon, no controls', async () => {
    get.mockResolvedValue(DARK);
    show();
    expect(await screen.findByTestId('branding-not-offered')).toHaveTextContent('Coming soon');
    expect(screen.queryByTestId('branding-save')).toBeNull();
    expect(screen.queryByLabelText('Sender display name')).toBeNull();
  });

  it('offered but not in the plan: points to the plans', async () => {
    get.mockResolvedValue({ ...DARK, available: true });
    show();
    expect(await screen.findByTestId('branding-not-in-plan')).toHaveTextContent('Business, Professional and Enterprise');
    expect(screen.getByRole('link', { name: 'View plans' })).toHaveAttribute('href', '/sign/settings/billing');
  });

  it('entitled admin: saves the name and normalised colours', async () => {
    get.mockResolvedValue(ON);
    save.mockResolvedValue({ ...ON, display_name: 'Acme Staffing', primary_color: '#0A7F3F', updated_at: '2026-11-01T10:00:00Z' });
    show();
    const name = await screen.findByLabelText('Sender display name');
    expect(screen.getByTestId('branding-save')).toBeDisabled();
    fireEvent.change(name, { target: { value: 'Acme Staffing' } });
    fireEvent.change(screen.getByLabelText('Primary colour'), { target: { value: '#0a7f3f' } });
    fireEvent.click(screen.getByTestId('branding-save'));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ display_name: 'Acme Staffing', primary_color: '#0A7F3F', accent_color: null }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Branding saved'));
  });

  it('refuses an invalid colour before saving', async () => {
    get.mockResolvedValue(ON);
    show();
    fireEvent.change(await screen.findByLabelText('Accent colour'), { target: { value: 'orange' } });
    expect(screen.getByText('Enter a colour as #RRGGBB.')).toBeInTheDocument();
    expect(screen.getByTestId('branding-save')).toBeDisabled();
  });

  it('refuses a non-PNG/JPEG logo in the browser without calling the server', async () => {
    get.mockResolvedValue(ON);
    show();
    const input = await screen.findByTestId('branding-logo-input');
    fireEvent.change(input, { target: { files: [new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' })] } });
    expect(await screen.findByText('The logo must be a PNG or JPEG image.')).toBeInTheDocument();
    expect(uploadLogo).not.toHaveBeenCalled();
  });

  it('uploads a PNG logo as base64', async () => {
    get.mockResolvedValue(ON);
    uploadLogo.mockResolvedValue({ ...ON, logo: { url: '/v1/sign/signing/brand-logo/x', content_type: 'image/png', byte_size: 3, width: 64, height: 32 } });
    show();
    const input = await screen.findByTestId('branding-logo-input');
    fireEvent.change(input, { target: { files: [new File([new Uint8Array([1, 2, 3])], 'logo.png', { type: 'image/png' })] } });
    await waitFor(() => expect(uploadLogo).toHaveBeenCalledWith('image/png', 'AQID'));
    expect(await screen.findByTestId('branding-logo')).toHaveAttribute('src', '/v1/sign/signing/brand-logo/x');
  });

  it('read-only without can_edit', async () => {
    get.mockResolvedValue({ ...ON, can_edit: false, display_name: 'Acme Staffing' });
    show();
    expect(await screen.findByLabelText('Sender display name')).toBeDisabled();
    expect(screen.queryByTestId('branding-save')).toBeNull();
    expect(screen.getByText('Only an Aramo Sign administrator can change branding.')).toBeInTheDocument();
  });
});
