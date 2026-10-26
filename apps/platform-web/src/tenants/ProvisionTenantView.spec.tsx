import { fireEvent, screen, waitFor } from '@testing-library/react';
import { ApiError } from '@aramo/fe-foundation';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { platformApi, type ProvisionTenantResult } from '../platform-api';

import { ProvisionTenantView, effectiveCapabilities, effectiveSlug, validateStep1, type ProvisionDraft } from './ProvisionTenantView';
import { ALL_TENANT_SCOPES, READ_ONLY_TENANT, renderAt, tenantSession } from './test-utils';

// PLATFORM-UX-1 F-4 (handoff §6.2) — the page gate (:provision), the three
// steps, step-1 validation, the slug live preview, capability cards (Core
// always on, Sourcing reserved, Personal locked to Core + Sign), the error copy
// and the success toast + landing on the new tenant's Overview.

const RESULT: ProvisionTenantResult = {
  tenant_id: 'tn-new',
  tenant_name: 'Halvorsen Clinics',
  tenant_kind: 'BUSINESS',
  owner_user_id: 'u',
  owner_email: 'owner@halvorsen.no',
  membership_id: 'm',
  capabilities: ['core', 'ats', 'portal'],
  invitation_sent: true,
};

const renderProvision = (scopes = ALL_TENANT_SCOPES) =>
  renderAt(<ProvisionTenantView session={tenantSession(scopes)} />, {
    path: '/tenants/new',
    url: '/tenants/new',
    session: tenantSession(scopes),
  });

const type = (label: string | RegExp, value: string): void => {
  fireEvent.change(screen.getByRole('textbox', { name: label }), { target: { value } });
};

const fillStep1 = (): void => {
  type(/Tenant name/, 'Halvorsen Clinics');
  type(/Owner email/, 'owner@halvorsen.no');
};

const draft = (o: Partial<ProvisionDraft> = {}): ProvisionDraft => ({
  name: 'Acme',
  kind: 'BUSINESS',
  email: 'a@acme.com',
  display: '',
  slug: '',
  caps: ['core', 'ats', 'portal'],
  send: true,
  ...o,
});

describe('provision rules', () => {
  it('validates step 1', () => {
    expect(validateStep1(draft({ name: 'A', email: 'nope', slug: 'Bad Slug' }))).toEqual({
      name: 'Enter at least 2 characters.',
      email: 'Enter a valid email address.',
      slug: 'Use lowercase letters, numbers and hyphens.',
    });
    expect(validateStep1(draft())).toEqual({});
  });
  it('fixes Personal to Core + Sign and never sends sourcing', () => {
    expect(effectiveCapabilities(draft({ kind: 'PERSONAL', caps: ['core', 'ats'] }))).toEqual(['core', 'sign']);
    expect(effectiveCapabilities(draft({ caps: ['ats', 'sourcing', 'sign'] }))).toEqual(['core', 'ats', 'sign']);
  });
  it('generates the slug from the name when empty', () => {
    expect(effectiveSlug(draft({ name: 'Fenwick & Rowe' }))).toBe('fenwick-and-rowe');
    expect(effectiveSlug(draft({ slug: 'fr' }))).toBe('fr');
  });
});

describe('ProvisionTenantView', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders the in-shell access denied without :provision', async () => {
    renderProvision(READ_ONLY_TENANT);
    expect(await screen.findByTestId('access-denied')).toBeInTheDocument();
    expect(screen.getByText(/This account can.t open Provision tenant/)).toBeInTheDocument();
    expect(screen.getByText('platform:tenant:provision')).toBeInTheDocument();
  });

  it('walks the three steps and submits the design body', async () => {
    const spy = vi.spyOn(platformApi, 'provisionTenant').mockResolvedValue(RESULT);
    renderProvision();
    expect(screen.getByRole('listitem', { current: 'step' })).toHaveTextContent('Organization & owner');

    // Step 1: validation blocks Continue until name + email are valid.
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Enter at least 2 characters.')).toBeInTheDocument();
    expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument();
    fillStep1();
    expect(screen.getByText('halvorsen-clinics.aramo.ai')).toBeInTheDocument();
    type(/Slug/, 'Bad slug!');
    expect(screen.getByText('Use lowercase letters, numbers and hyphens.')).toBeInTheDocument();
    type(/Slug/, 'halvorsen');
    expect(screen.getByText('halvorsen.aramo.ai')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    // Step 2: Core always on, Sourcing reserved, defaults Core + ATS + Portal.
    expect(screen.getByRole('listitem', { current: 'step' })).toHaveTextContent('Capabilities');
    expect(screen.getByRole('checkbox', { name: /Core/ })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /Core/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Sourcing/ })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /Sourcing/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /^ATS/ })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: /^Sign/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Send owner invitation now' }));
    expect(screen.getByText('No invitation is sent. You can send it later from the tenant page.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));

    // Step 3: summary, then Provision tenant.
    expect(screen.getByText('Core, ATS, Portal, Sign')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Provision tenant' }));
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({
        name: 'Halvorsen Clinics',
        owner_email: 'owner@halvorsen.no',
        owner_display_name: undefined,
        capabilities: ['core', 'ats', 'portal', 'sign'],
        invite_owner: false,
        kind: 'BUSINESS',
        slug: 'halvorsen',
      }),
    );
    expect(await screen.findByText('Halvorsen Clinics provisioned · owner invite sent.')).toBeInTheDocument();
    // The toast renders before the post-provision navigation commits; wait for it
    // rather than reading the location synchronously (flaked under CI load).
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/tenants/tn-new?tab=overview'));
  });

  it('locks Personal to Core + Sign with the note', () => {
    renderProvision();
    fillStep1();
    fireEvent.click(screen.getByRole('radio', { name: /Personal/ }));
    expect(screen.getByRole('radio', { name: /Personal/ })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText(/Other capabilities need a Business tenant/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /^Sign/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /^Sign/ })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /^ATS/ })).not.toBeChecked();
    expect(screen.getAllByText('Set by Personal').length).toBeGreaterThan(0);
  });

  it.each([
    ['TENANT_ALREADY_EXISTS', 409, 'A tenant with this name or slug already exists. Choose a different name or slug.', 'Organization & owner'],
    ['EMAIL_UNAVAILABLE', 409, /One person can belong to only one organization/, 'Organization & owner'],
    ['COGNITO_PROVISION_FAILED', 502, /We couldn’t create the owner’s sign-in account/, 'Review'],
  ])('maps %s to its copy and step', async (code, status, copy, step) => {
    vi.spyOn(platformApi, 'provisionTenant').mockRejectedValue(new ApiError(status, 'x', code));
    renderProvision();
    fillStep1();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Provision tenant' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(copy);
    expect(alert).toHaveTextContent(code);
    expect(screen.getByRole('listitem', { current: 'step' })).toHaveTextContent(step);
  });

  it('shows a reserved slug inline under the field', async () => {
    vi.spyOn(platformApi, 'provisionTenant').mockRejectedValue(
      new ApiError(400, 'reserved', 'VALIDATION_ERROR', { reason: 'reserved_slug' }),
    );
    renderProvision();
    fillStep1();
    type(/Slug/, 'admin');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Provision tenant' }));
    expect(await screen.findByText('This address is reserved. Choose a different slug.')).toBeInTheDocument();
    expect(screen.getByRole('listitem', { current: 'step' })).toHaveTextContent('Organization & owner');
  });
});
