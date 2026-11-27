import { describe, expect, it, vi } from 'vitest';
import type { DocumentSourceProviderPort, EsignRepository, EsignService, SavedMarksBinding, SessionContext } from '@aramo/sign';

import { EsignSignerController } from '../app/esign-http.controller.js';
import { SignerProfilePrefillService } from '../app/signing/signer-profile-prefill.service.js';

// Aramo-Sign-Field-Test-Batch-1 §2 SIG-3 / SIG-7, as amended by A1 — the server decides who gets
// the signer's own profile values: a signed-in (SELF / INBOX) session only. An emailed link, a
// hosted session and a guest get profile_prefill: null. Signing never writes to the profile.

const ctx: SessionContext = { session_id: 's1', tenant_id: 'tenant-env', envelope_id: 'e1', signer_id: 'sg1' };
const USER = '11111111-1111-4111-8111-111111111111';
const OWN_TENANT = 'tenant-own';
const PROFILE = {
  display_name: 'Priya Raman',
  title: 'Recruiter',
  company: 'Northwind',
  address_line1: null,
  address_line2: null,
  city: null,
  region: null,
  postal_code: null,
  country: null,
  phone: null,
  updated_at: new Date(),
};

function serviceWith(binding: SavedMarksBinding | null, profile: typeof PROFILE | null = PROFILE) {
  const bindings = { bindingFor: vi.fn(async () => binding), recipientEmail: vi.fn(async () => 'Priya@Example.com') };
  const profiles = { getProfile: vi.fn(async () => profile), putProfile: vi.fn() };
  return { svc: new SignerProfilePrefillService(bindings as never, profiles as never), bindings, profiles };
}

describe('SIG-11 — profile_prefill by binding kind', () => {
  it('signed_in (SELF / INBOX): the profile values and the recipient email, under the user’s own tenant', async () => {
    const { svc, profiles } = serviceWith({ kind: 'signed_in', user_id: USER, tenant_id: OWN_TENANT });
    expect(await svc.prefillFor(ctx)).toEqual({ FIRST_NAME: 'Priya', LAST_NAME: 'Raman', EMAIL: 'Priya@Example.com', COMPANY: 'Northwind', TITLE: 'Recruiter' });
    expect(profiles.getProfile).toHaveBeenCalledWith(OWN_TENANT, USER);
  });

  it('signed_in without a stored profile: the recipient email only', async () => {
    const { svc } = serviceWith({ kind: 'signed_in', user_id: USER, tenant_id: OWN_TENANT }, null);
    expect(await svc.prefillFor(ctx)).toEqual({ EMAIL: 'Priya@Example.com' });
  });

  it('an emailed link opened while signed in (email_match): null, and the profile is never read', async () => {
    const { svc, profiles } = serviceWith({ kind: 'email_match', user_id: USER, tenant_id: OWN_TENANT });
    expect(await svc.prefillFor(ctx)).toBeNull();
    expect(profiles.getProfile).not.toHaveBeenCalled();
  });

  it('a hosted session or a guest (no binding): null', async () => {
    const { svc, profiles } = serviceWith(null);
    expect(await svc.prefillFor(ctx)).toBeNull();
    expect(profiles.getProfile).not.toHaveBeenCalled();
  });

  it('a lookup failure never fails the view', async () => {
    const svc = new SignerProfilePrefillService({ bindingFor: vi.fn(async () => { throw new Error('db down'); }) } as never, {} as never);
    expect(await svc.prefillFor(ctx)).toBeNull();
  });

  it('A1-5 — reading the pre-fill never writes the profile', async () => {
    const { svc, profiles } = serviceWith({ kind: 'signed_in', user_id: USER, tenant_id: OWN_TENANT });
    await svc.prefillFor(ctx);
    expect(profiles.putProfile).not.toHaveBeenCalled();
  });
});

describe('SIG-11 — POST /v1/sign/signing/document carries profile_prefill', () => {
  const view = { documents: [], fields: [] };
  const service = { resolveSession: vi.fn(async () => ctx), getSignerDocumentView: vi.fn(async () => view) } as unknown as EsignService;
  const controller = (prefill: SignerProfilePrefillService) =>
    new EsignSignerController(service, {} as EsignRepository, {} as DocumentSourceProviderPort, undefined, undefined, undefined, undefined, undefined, undefined, prefill);

  it('a signed-in session: the values', async () => {
    const res = await controller(serviceWith({ kind: 'signed_in', user_id: USER, tenant_id: OWN_TENANT }).svc).document({ token: 't' }, 'r');
    expect(res).toMatchObject({ profile_prefill: { COMPANY: 'Northwind', TITLE: 'Recruiter', EMAIL: 'Priya@Example.com' } });
  });

  it('an emailed link: null', async () => {
    const res = await controller(serviceWith({ kind: 'email_match', user_id: USER, tenant_id: OWN_TENANT }).svc).document({ token: 't' }, 'r');
    expect(res).toMatchObject({ profile_prefill: null });
  });
});
