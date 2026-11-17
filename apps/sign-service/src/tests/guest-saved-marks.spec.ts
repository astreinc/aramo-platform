import { describe, expect, it, vi } from 'vitest';
import { GuestSavedMarksRepository, type SavedMarksBinding, type SessionContext } from '@aramo/sign';

import { GuestSavedMarksService } from '../app/signing/guest-saved-marks.service.js';
import { validateSettings } from '../app/me/profile/sign-me-profile.service.js';

// Aramo-Sign-Mobile-Amendment-M-A15-Guest-Saved-Signature-v1_0 — whose saved signature a
// signing session may use (§3), the view's saved_marks and the save route (§4), the
// opt-out setting (§5).

const ctx: SessionContext = { session_id: 's1', tenant_id: 'tenant-env', envelope_id: 'e1', signer_id: 'sg1' };
const USER = '11111111-1111-4111-8111-111111111111';
const OWN_TENANT = 'tenant-own';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function prismaWith(opts: {
  session: { origin: string | null; authenticated_user_id: string | null } | null;
  signer: { email: string | null; recipient_kind: string } | null;
  rows?: Array<{ user_id: string; tenant_id: string | null }>;
}) {
  const queries: string[] = [];
  const prisma = {
    signingSession: { findFirst: vi.fn(async () => opts.session) },
    signer: { findFirst: vi.fn(async () => opts.signer) },
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      queries.push(sql);
      // activeUserTenant (by id) vs verifiedUserByEmail (by email).
      if (sql.includes('WHERE u.id = $1::uuid')) return [{ tenant_id: OWN_TENANT }];
      return opts.rows ?? [];
    }),
  };
  return { prisma, queries };
}

const repo = (p: ReturnType<typeof prismaWith>['prisma']) => new GuestSavedMarksRepository(p as never);

describe('M-A15 §3 — whose saved marks a signing session may use', () => {
  it('§3.1 SELF: the authenticated user, under their own tenant (no email match)', async () => {
    const { prisma, queries } = prismaWith({ session: { origin: 'SELF', authenticated_user_id: USER }, signer: { email: 'x@y.test', recipient_kind: 'SIGNER' } });
    expect(await repo(prisma).bindingFor(ctx)).toEqual({ kind: 'signed_in', user_id: USER, tenant_id: OWN_TENANT });
    expect(queries.some((q) => q.includes('lower(btrim(u.email)) = $1'))).toBe(false);
  });

  it('D-1 INBOX: the verified-email user, treated as signed in (the row never records its user)', async () => {
    const { prisma } = prismaWith({ session: { origin: 'INBOX', authenticated_user_id: null }, signer: { email: 'pat@example.test', recipient_kind: 'SIGNER' }, rows: [{ user_id: USER, tenant_id: OWN_TENANT }] });
    expect(await repo(prisma).bindingFor(ctx)).toEqual({ kind: 'signed_in', user_id: USER, tenant_id: OWN_TENANT });
  });

  it('§3.2 LINK and legacy (NULL): the one verified-email user', async () => {
    for (const origin of ['LINK', null]) {
      const { prisma } = prismaWith({
        session: { origin, authenticated_user_id: null },
        signer: { email: ' Pat@Example.TEST ', recipient_kind: 'WITNESS' },
        rows: [{ user_id: USER, tenant_id: OWN_TENANT }],
      });
      expect(await repo(prisma).bindingFor(ctx)).toEqual({ kind: 'email_match', user_id: USER, tenant_id: OWN_TENANT });
      // Normalized email; both proofs (federated link, verified Personal signup) are in the query.
      const call = prisma.$queryRawUnsafe.mock.calls[0] as unknown as [string, string];
      expect(call[1]).toBe('pat@example.test');
      expect(call[0]).toContain('ExternalIdentity');
      expect(call[0]).toContain('PersonalSignupRequest');
      expect(call[0]).toContain('email_verified_at IS NOT NULL');
    }
  });

  it('§3.2 nothing when no user, or more than one, qualifies', async () => {
    for (const rows of [[], [{ user_id: USER, tenant_id: OWN_TENANT }, { user_id: 'u2', tenant_id: 't2' }]]) {
      const { prisma } = prismaWith({ session: { origin: 'LINK', authenticated_user_id: null }, signer: { email: 'a@b.test', recipient_kind: 'SIGNER' }, rows });
      expect(await repo(prisma).bindingFor(ctx)).toBeNull();
    }
  });

  it('§3.3 never for a HOSTED session or a recipient other than SIGNER / WITNESS', async () => {
    const hosted = prismaWith({ session: { origin: 'HOSTED', authenticated_user_id: null }, signer: { email: 'a@b.test', recipient_kind: 'SIGNER' }, rows: [{ user_id: USER, tenant_id: OWN_TENANT }] });
    expect(await repo(hosted.prisma).bindingFor(ctx)).toBeNull();
    for (const kind of ['IN_PERSON_SIGNER', 'RECEIVES_COPY']) {
      const p = prismaWith({ session: { origin: 'SELF', authenticated_user_id: USER }, signer: { email: 'a@b.test', recipient_kind: kind } });
      expect(await repo(p.prisma).bindingFor(ctx)).toBeNull();
    }
  });
});

function serviceWith(binding: SavedMarksBinding | null, opts: { offers?: boolean; rows?: Array<{ slot: string }> } = {}) {
  const bindings = { bindingFor: vi.fn(async () => binding) };
  const rows = (opts.rows ?? []).map((r) => ({ ...r, kind: 'DRAWN', typed_name: null, font_key: null, image_data_url: PNG, updated_at: new Date() }));
  const saved = { list: vi.fn(async () => rows), put: vi.fn(async () => undefined) };
  const settings = { offersSavedSignatureOnLinks: vi.fn(async () => opts.offers ?? true) };
  return { svc: new GuestSavedMarksService(bindings as never, saved as never, settings as never), saved, settings };
}

describe('M-A15 §4.1 — the view’s saved_marks', () => {
  const signedIn: SavedMarksBinding = { kind: 'signed_in', user_id: USER, tenant_id: OWN_TENANT };
  const link: SavedMarksBinding = { kind: 'email_match', user_id: USER, tenant_id: OWN_TENANT };

  it('signed in: the marks and can_save true, even with nothing saved yet', async () => {
    const { svc, saved } = serviceWith(signedIn, { rows: [{ slot: 'signature' }] });
    expect(await svc.viewFor(ctx)).toEqual({ signature: { kind: 'DRAWN', typed_name: null, image_data_url: PNG }, initials: null, can_save: true });
    expect(saved.list).toHaveBeenCalledWith(OWN_TENANT, USER);
    expect(await serviceWith(signedIn).svc.viewFor(ctx)).toEqual({ signature: null, initials: null, can_save: true });
  });

  it('emailed link: read only (can_save false); nothing saved → null', async () => {
    expect(await serviceWith(link, { rows: [{ slot: 'initials' }] }).svc.viewFor(ctx)).toMatchObject({ signature: null, can_save: false });
    expect(await serviceWith(link).svc.viewFor(ctx)).toBeNull();
  });

  it('§5 the opt-out hides it on emailed links only', async () => {
    const off = serviceWith(link, { offers: false, rows: [{ slot: 'signature' }] });
    expect(await off.svc.viewFor(ctx)).toBeNull();
    const signedInOff = serviceWith(signedIn, { offers: false, rows: [{ slot: 'signature' }] });
    expect(await signedInOff.svc.viewFor(ctx)).toMatchObject({ can_save: true });
    expect(signedInOff.settings.offersSavedSignatureOnLinks).not.toHaveBeenCalled();
  });

  it('a lookup failure never fails the view', async () => {
    const svc = new GuestSavedMarksService({ bindingFor: vi.fn(async () => { throw new Error('db down'); }) } as never, {} as never, {} as never);
    expect(await svc.viewFor(ctx)).toBeNull();
  });
});

describe('M-A15 §4.2 — save as my default', () => {
  const body = { token: 'tok', slot: 'signature', kind: 'DRAWN', image_data_url: PNG };

  it('a signed-in session saves to that user, under their own tenant', async () => {
    const { svc, saved } = serviceWith({ kind: 'signed_in', user_id: USER, tenant_id: OWN_TENANT });
    expect(await svc.save(ctx, body, 'r1')).toEqual({ kind: 'DRAWN', typed_name: null, image_data_url: PNG });
    expect(saved.put).toHaveBeenCalledWith(OWN_TENANT, USER, 'signature', { kind: 'DRAWN', typed_name: null, font_key: null, image_data_url: PNG });
  });

  it('an emailed link (or no binding) is refused: 403 saved_mark_not_allowed', async () => {
    for (const b of [{ kind: 'email_match', user_id: USER, tenant_id: OWN_TENANT } as const, null]) {
      const { svc, saved } = serviceWith(b);
      await expect(svc.save(ctx, body, 'r1')).rejects.toMatchObject({ statusCode: 403, context: { details: { reason: 'saved_mark_not_allowed' } } });
      expect(saved.put).not.toHaveBeenCalled();
    }
  });

  it('validates the slot and the mark as M-A3 §4', async () => {
    const { svc } = serviceWith({ kind: 'signed_in', user_id: USER, tenant_id: OWN_TENANT });
    await expect(svc.save(ctx, { ...body, slot: 'stamp' }, 'r1')).rejects.toMatchObject({ context: { details: { reason: 'invalid_slot' } } });
    await expect(svc.save(ctx, { ...body, image_data_url: 'data:image/gif;base64,AAAA' }, 'r1')).rejects.toMatchObject({ context: { details: { reason: 'invalid_image' } } });
  });
});

describe('M-A15 §5 — settings: offer_saved_signature_on_links is optional on PUT', () => {
  it('two fields still validate (existing clients); the boolean is accepted; anything else refused', () => {
    expect(validateSettings({ date_format: 'MM/DD/YYYY', default_field_size: 'M' }, 'r')).toEqual({ date_format: 'MM/DD/YYYY', default_field_size: 'M' });
    expect(validateSettings({ date_format: 'MM/DD/YYYY', default_field_size: 'M', offer_saved_signature_on_links: false }, 'r')).toMatchObject({ offer_saved_signature_on_links: false });
    expect(() => validateSettings({ date_format: 'MM/DD/YYYY', default_field_size: 'M', offer_saved_signature_on_links: 'no' }, 'r')).toThrow();
  });
});

describe('M-A16 §3 — "Save to my Aramo inbox" applies to emailed-link sessions only', () => {
  it('LINK and legacy (NULL) yes; INBOX, SELF and HOSTED no', async () => {
    for (const [origin, want] of [['LINK', true], [null, true], ['INBOX', false], ['SELF', false], ['HOSTED', false]] as const) {
      const { prisma } = prismaWith({ session: { origin, authenticated_user_id: null }, signer: null });
      expect(await repo(prisma).inboxSaveAvailable(ctx)).toBe(want);
    }
  });
});
