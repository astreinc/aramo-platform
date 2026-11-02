import 'reflect-metadata';
import { AramoError } from '@aramo/common';
import { type AuthContextType } from '@aramo/auth';
import { FEATURE_AVAILABILITY } from '@aramo/subscription';
import { DelegationRefusedError, SignerAccessCodeLockedError, SignerAccessCodeRequiredError, SignerNotYetEligibleError } from '@aramo/sign';
import { describe, expect, it, vi } from 'vitest';

import { EsignSignerController, toHttp } from '../app/esign-http.controller.js';
import { SenderContextService } from '../app/sender/sender-context.service.js';
import { SenderEnvelopeService } from '../app/sender/sender-envelope.service.js';
import { SignFeatureGate } from '../app/sign-feature.gate.js';

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED (2bd74ca5) §1.17 witness and
// delegate signing, §1.9 access code — the sign-service surface: dark by default (R-8),
// the Business-and-up placement of witness / delegate (B+), the authoring validation,
// the access code never leaving as text, and the signer-route error mapping.

const AUTH: AuthContextType = {
  sub: '11111111-1111-7111-8111-111111111111',
  consumer_type: 'sign',
  actor_kind: 'user',
  tenant_id: '22222222-2222-7222-8222-222222222222',
  scopes: ['sign:envelope:read', 'sign:envelope:create', 'sign:envelope:send'],
  iat: 0,
  exp: 0,
};

const ALL_ON = new SignFeatureGate({ ...FEATURE_AVAILABILITY, 'sign.witness_signing': 'AVAILABLE', 'sign.delegate_signing': 'AVAILABLE', 'sign.access_code': 'AVAILABLE' });

function contextService(kind: string, features?: SignFeatureGate) {
  const tenants = {
    findById: vi.fn(async () => ({ id: AUTH.tenant_id, name: 'Astre', kind, is_active: true, status: 'ACTIVE' })),
    findSlugById: vi.fn(async () => 'astre'),
    findOrganizationNameById: vi.fn(async () => 'Astre'),
  };
  const identity = {
    findUserById: vi.fn(async () => ({ id: AUTH.sub, email: 'p@astre.test', display_name: 'P' })),
    findMembership: vi.fn(async () => ({ id: 'm1', is_active: true })),
    findRoleKeysForMembership: vi.fn(async () => ['sign_sender']),
  };
  // A PERSONAL tenant with Personal sending switched on (so authoring reaches the feature rules).
  const personal = { authoringOpen: () => true, ensureFreeSubscription: vi.fn(async () => undefined) };
  return new SenderContextService(tenants as never, identity as never, features, personal as never);
}

function envelopeService(kind = 'BUSINESS', features?: SignFeatureGate, detail: Record<string, unknown> = {}) {
  const ctx = contextService(kind, features);
  const repo = {
    replaceDraftRecipients: vi.fn(async () => []),
    updateDraft: vi.fn(async () => 1),
    getEnvelopeDetail: vi.fn(async () => ({
      source_application: 'aramo-sign', id: 'e1', subject: 'S', status: 'DRAFT', created_by: AUTH.sub, created_at: new Date(), sent_at: null, completed_at: null,
      declined_at: null, voided_at: null, documents: [], signers: [], routing_mode: 'PARALLEL', allow_delegation: false, revision: 1, ...detail,
    })),
    reminderHistory: vi.fn(async () => []),
  };
  const identity = { findUserById: vi.fn(async () => null) };
  const svc = new SenderEnvelopeService(
    repo as never, {} as never, ctx, identity as never, {} as never, {} as never, {} as never,
    undefined, undefined, undefined, undefined, features, undefined,
  );
  return { svc, repo };
}

const signer = (name: string, extra: Record<string, unknown> = {}) => ({ name, email: `${name.toLowerCase()}@x.test`, ...extra });

// PO authorization (R-8) 2026-11-01: sign.access_code is AVAILABLE in production; witness and
// delegate stay dark. DARK exercises all three off.
const DARK = new SignFeatureGate({ ...FEATURE_AVAILABILITY, 'sign.access_code': 'NOT_AVAILABLE' });

describe('launch availability — dark until the PO flips it (R-8)', () => {
  it('the production registry keeps sign.witness_signing and sign.delegate_signing NOT_AVAILABLE; sign.access_code is AVAILABLE (PO 2026-11-01)', () => {
    expect(FEATURE_AVAILABILITY['sign.witness_signing']).toBe('NOT_AVAILABLE');
    expect(FEATURE_AVAILABILITY['sign.delegate_signing']).toBe('NOT_AVAILABLE');
    expect(FEATURE_AVAILABILITY['sign.access_code']).toBe('AVAILABLE');
  });

  it('the sender context reports witness and delegate unavailable and the access code available (production registry)', async () => {
    const view = await contextService('BUSINESS').context(AUTH, 'r');
    expect(view.features).toMatchObject({ witness_signing: false, delegate_signing: false, access_code: true });
    expect((await contextService('BUSINESS', DARK).context(AUTH, 'r')).features).toMatchObject({ access_code: false });
  });

  it('when available: witness and delegate for a BUSINESS tenant only (B+); the access code for every plan', async () => {
    expect((await contextService('BUSINESS', ALL_ON).context(AUTH, 'r')).features).toMatchObject({ witness_signing: true, delegate_signing: true, access_code: true });
    expect((await contextService('PERSONAL', ALL_ON).context(AUTH, 'r')).features).toMatchObject({ witness_signing: false, delegate_signing: false, access_code: true });
  });

  it('Consolidated Directive B2 — messaging and identity-check keys: dark in production; messaging by availability, identity checks BUSINESS only', async () => {
    expect((await contextService('BUSINESS').context(AUTH, 'r')).features).toMatchObject({ sms_delivery: false, whatsapp_delivery: false, sms_otp: false, id_verification: false, kba: false });
    const on = new SignFeatureGate({
      ...FEATURE_AVAILABILITY,
      'sign.sms_delivery': 'AVAILABLE',
      'sign.whatsapp_delivery': 'AVAILABLE',
      'sign.sms_otp': 'AVAILABLE',
      'sign.id_verification': 'AVAILABLE',
      'sign.kba': 'AVAILABLE',
    });
    expect((await contextService('BUSINESS', on).context(AUTH, 'r')).features).toMatchObject({ sms_delivery: true, whatsapp_delivery: true, sms_otp: true, id_verification: true, kba: true });
    expect((await contextService('PERSONAL', on).context(AUTH, 'r')).features).toMatchObject({ sms_delivery: true, whatsapp_delivery: true, sms_otp: true, id_verification: false, kba: false });
  });

  it('dark: a WITNESS, an access code and allow_delegation=true are refused 403 before any write; allow_delegation=false is accepted', async () => {
    const { svc, repo } = envelopeService('BUSINESS', DARK);
    const refused = { code: 'ESIGN_FEATURE_NOT_AVAILABLE', statusCode: 403 };
    await expect(svc.replaceRecipients(AUTH, 'e1', { recipients: [signer('A'), signer('W', { recipient_kind: 'WITNESS', witness_for_index: 0 })] }, 'r')).rejects.toMatchObject({
      ...refused,
      context: { details: { feature_key: 'sign.witness_signing' } },
    });
    await expect(svc.replaceRecipients(AUTH, 'e1', { recipients: [signer('A', { access_code: '1234' })] }, 'r')).rejects.toMatchObject({
      ...refused,
      context: { details: { feature_key: 'sign.access_code' } },
    });
    await expect(svc.update(AUTH, 'e1', { allow_delegation: true }, 'r')).rejects.toMatchObject({ ...refused, context: { details: { feature_key: 'sign.delegate_signing' } } });
    expect(repo.replaceDraftRecipients).not.toHaveBeenCalled();
    expect(repo.updateDraft).not.toHaveBeenCalled();
    await svc.update(AUTH, 'e1', { allow_delegation: false }, 'r');
    expect(repo.updateDraft).toHaveBeenLastCalledWith({ tenant_id: AUTH.tenant_id, envelope_id: 'e1', allow_delegation: false });
  });
});

describe('§1.17 witness authoring (available)', () => {
  it('a WITNESS names a signer by list position; the repository receives witness_for_index', async () => {
    const { svc, repo } = envelopeService('BUSINESS', ALL_ON);
    await svc.replaceRecipients(AUTH, 'e1', { recipients: [signer('A'), signer('W', { recipient_kind: 'WITNESS', witness_for_index: 0 })] }, 'r');
    const sent = (repo.replaceDraftRecipients.mock.calls[0] as unknown as [{ recipients: Array<Record<string, unknown>> }])[0].recipients;
    expect(sent.map((r) => [r['recipient_kind'], r['witness_for_index']])).toEqual([['SIGNER', null], ['WITNESS', 0]]);
  });

  it.each([
    ['missing', { recipient_kind: 'WITNESS' }, 'witness_for_required'],
    ['self', { recipient_kind: 'WITNESS', witness_for_index: 1 }, 'witness_for_required'],
    ['out of range', { recipient_kind: 'WITNESS', witness_for_index: 5 }, 'witness_for_required'],
    ['on a non-witness', { witness_for_index: 0 }, 'witness_for_not_allowed'],
  ] as const)('refuses witness_for_index %s (%s)', async (_label, extra, reason) => {
    const { svc, repo } = envelopeService('BUSINESS', ALL_ON);
    await expect(svc.replaceRecipients(AUTH, 'e1', { recipients: [signer('A'), signer('W', extra)] }, 'r')).rejects.toMatchObject({ code: 'VALIDATION_ERROR', context: { details: { reason } } });
    expect(repo.replaceDraftRecipients).not.toHaveBeenCalled();
  });

  it('a witness attests for a signer (not a copy recipient or another witness), and one witness per signer', async () => {
    const { svc } = envelopeService('BUSINESS', ALL_ON);
    await expect(
      svc.replaceRecipients(AUTH, 'e1', { recipients: [signer('C', { recipient_kind: 'RECEIVES_COPY', copy_delivery: 'ON_SEND' }), signer('W', { recipient_kind: 'WITNESS', witness_for_index: 0 })] }, 'r'),
    ).rejects.toMatchObject({ context: { details: { reason: 'witness_for_invalid' } } });
    await expect(
      svc.replaceRecipients(AUTH, 'e1', { recipients: [signer('A'), signer('W1', { recipient_kind: 'WITNESS', witness_for_index: 0 }), signer('W2', { recipient_kind: 'WITNESS', witness_for_index: 0 })] }, 'r'),
    ).rejects.toMatchObject({ context: { details: { reason: 'witness_duplicate' } } });
  });

  it('a PERSONAL account cannot add a witness or allow delegation (B+ placement), even when available', async () => {
    const { svc } = envelopeService('PERSONAL', ALL_ON);
    await expect(svc.replaceRecipients(AUTH, 'e1', { recipients: [signer('A'), signer('W', { recipient_kind: 'WITNESS', witness_for_index: 0 })] }, 'r')).rejects.toMatchObject({
      code: 'ESIGN_FEATURE_NOT_AVAILABLE',
      context: { details: { reason: 'plan_not_eligible' } },
    });
    await expect(svc.update(AUTH, 'e1', { allow_delegation: true }, 'r')).rejects.toMatchObject({ context: { details: { reason: 'plan_not_eligible' } } });
  });

  it('readiness: when signing in order, a witness must come after the signer it witnesses', () => {
    const { svc } = envelopeService('BUSINESS', ALL_ON);
    const d = (routing_mode: string, wOrder: number) => ({
      routing_mode,
      documents: [{ id: 'd' }],
      recipients: [
        { id: 'a', name: 'A', recipient_kind: 'SIGNER', signing_order: 2 },
        { id: 'w', name: 'W', recipient_kind: 'WITNESS', witness_for_signer_id: 'a', signing_order: wOrder },
      ],
      fields: [{ signer_id: 'a', field_type: 'SIGNATURE' }, { signer_id: 'w', field_type: 'SIGNATURE' }],
    });
    expect(svc.readiness(d('SEQUENTIAL', 1) as never).problems).toContain('W witnesses A and must sign after them');
    expect(svc.readiness(d('SEQUENTIAL', 3) as never).ok).toBe(true);
    expect(svc.readiness(d('PARALLEL', 1) as never).ok).toBe(true);
  });
});

describe('§1.9 access code authoring (available)', () => {
  it('is hashed before it reaches the repository (never the code), null clears, omitted keeps', async () => {
    const { svc, repo } = envelopeService('BUSINESS', ALL_ON);
    await svc.replaceRecipients(AUTH, 'e1', { recipients: [signer('A', { access_code: ' Blue-42 ' }), signer('B', { id: 'b1', access_code: null }), signer('C', { id: 'c1' })] }, 'r');
    const sent = (repo.replaceDraftRecipients.mock.calls[0] as unknown as [{ recipients: Array<Record<string, unknown>> }])[0].recipients;
    expect(String(sent[0]!['access_code_hash'])).toMatch(/^scrypt\$/);
    expect(JSON.stringify(sent)).not.toContain('Blue-42');
    expect(sent[1]!['access_code_hash']).toBeNull();
    expect('access_code_hash' in sent[2]!).toBe(false);
  });

  it('refuses an invalid code and a code on a recipient who does not sign through a link', async () => {
    const { svc } = envelopeService('BUSINESS', ALL_ON);
    await expect(svc.replaceRecipients(AUTH, 'e1', { recipients: [signer('A', { access_code: '12' })] }, 'r')).rejects.toMatchObject({ context: { details: { reason: 'access_code_invalid' } } });
    await expect(
      svc.replaceRecipients(AUTH, 'e1', { recipients: [signer('A'), signer('C', { recipient_kind: 'RECEIVES_COPY', copy_delivery: 'ON_SEND', access_code: '1234' })] }, 'r'),
    ).rejects.toMatchObject({ context: { details: { reason: 'access_code_not_allowed' } } });
    await expect(svc.replaceRecipients(AUTH, 'e1', { recipients: [signer('I', { recipient_kind: 'IN_PERSON_SIGNER', access_code: '1234' })] }, 'r')).rejects.toMatchObject({
      context: { details: { reason: 'access_code_not_allowed' } },
    });
  });

  it('the sender detail says whether a code is set or locked, never the code or its hash', async () => {
    const row = {
      id: 's1', name: 'A', email: 'a@x.test', status: 'PENDING', signing_order: 1, recipient_kind: 'SIGNER', copy_delivery: null, bound_user_id: null,
      viewed_at: null, signed_at: null, declined_at: null, decline_reason: null, signer_role: null, witness_for_signer_id: null,
      access_code_hash: 'scrypt$16384$8$1$c2FsdA$aGFzaA', access_code_locked_at: new Date(), access_code_failed_count: 5,
      delegated_at: new Date('2026-11-01T00:00:00Z'), delegated_from_name: 'Orig', delegated_from_email: 'orig@x.test',
    };
    const { svc } = envelopeService('BUSINESS', ALL_ON, { signers: [row], allow_delegation: true });
    const d = await svc.detail(AUTH, 'e1', 'r');
    expect(d.allow_delegation).toBe(true);
    expect(d.recipients[0]).toMatchObject({
      access_code_set: true,
      access_code_locked: true,
      witness_for_signer_id: null,
      delegated_from: { name: 'Orig', email: 'orig@x.test', delegated_at: '2026-11-01T00:00:00.000Z' },
    });
    expect(JSON.stringify(d)).not.toContain('scrypt');
  });
});

describe('signer routes', () => {
  it('delegate is refused 403 while sign.delegate_signing is not available, before any session is resolved', async () => {
    const service = { resolveSession: vi.fn(), delegateSigner: vi.fn() };
    const ctl = new EsignSignerController(service as never, {} as never, {} as never);
    await expect(ctl.delegate({ token: 't', name: 'D', email: 'd@x.test' }, 'r')).rejects.toMatchObject({ code: 'ESIGN_FEATURE_NOT_AVAILABLE', statusCode: 403 });
    expect(service.resolveSession).not.toHaveBeenCalled();
  });

  it('B3 — document offers can_delegate only when the engine allows it and sign.delegate_signing is available', async () => {
    const ctx = { session_id: 's', tenant_id: 't', envelope_id: 'e', signer_id: 'x' };
    const view = { documents: [], fields: [], message: null, can_delegate: true };
    const service = { resolveSession: vi.fn(async () => ctx), getSignerDocumentView: vi.fn(async () => view) };
    const dark = new EsignSignerController(service as never, {} as never, {} as never);
    await expect(dark.document({ token: 't' }, 'r')).resolves.toMatchObject({ can_delegate: false });
    const on = new EsignSignerController(service as never, {} as never, {} as never, undefined, undefined, ALL_ON);
    await expect(on.document({ token: 't' }, 'r')).resolves.toMatchObject({ can_delegate: true });
    service.getSignerDocumentView.mockResolvedValueOnce({ ...view, can_delegate: false });
    await expect(on.document({ token: 't' }, 'r')).resolves.toMatchObject({ can_delegate: false });
  });

  it('delegate (available) resolves the session, delegates, then dispatches the delegate invitation', async () => {
    const ctx = { session_id: 's', tenant_id: 't', envelope_id: 'e', signer_id: 'x' };
    const service = { resolveSession: vi.fn(async () => ctx), delegateSigner: vi.fn(async () => ({ signer_id: 'x' })) };
    const invitations = { dispatch: vi.fn(async () => 1) };
    const ctl = new EsignSignerController(service as never, {} as never, {} as never, undefined, invitations as never, ALL_ON);
    await expect(ctl.delegate({ token: 't', name: 'D', email: 'd@x.test', reason: 'away' }, 'r')).resolves.toEqual({ delegated: true });
    expect(service.delegateSigner).toHaveBeenCalledWith(ctx, { name: 'D', email: 'd@x.test', reason: 'away' });
    expect(invitations.dispatch).toHaveBeenCalledWith({ tenant_id: 't', envelope_id: 'e' });
  });

  it('access-code passes the entered code to the engine and never echoes it', async () => {
    const service = { verifyRecipientAccessCode: vi.fn(async () => ({ verified: true })) };
    const ctl = new EsignSignerController(service as never, {} as never, {} as never);
    const out = await ctl.accessCode({ token: 't', access_code: 'Blue-42' }, { ip: '1.2.3.4' } as never, 'r', 'ua');
    expect(out).toEqual({ verified: true });
    expect(service.verifyRecipientAccessCode).toHaveBeenCalledWith('t', 'Blue-42', { ip_address: '1.2.3.4', user_agent: 'ua' });
  });

  it('maps the new engine errors to stable codes', () => {
    const required = toHttp(new SignerAccessCodeRequiredError('s'), 'r');
    expect(required).toMatchObject({ code: 'SIGNER_ACCESS_CODE_REQUIRED', statusCode: 403, context: { details: { reason: 'access_code_required' } } });
    const wrong = toHttp(new SignerAccessCodeRequiredError('s', 'access_code_incorrect', 2), 'r');
    expect(wrong).toMatchObject({ code: 'SIGNER_ACCESS_CODE_REQUIRED', context: { details: { reason: 'access_code_incorrect', attempts_remaining: 2 } } });
    expect(toHttp(new SignerAccessCodeLockedError('s'), 'r')).toMatchObject({ code: 'SIGNER_ACCESS_CODE_LOCKED', statusCode: 423 });
    expect(toHttp(new SignerNotYetEligibleError('s', 'witness_signer_not_signed'), 'r')).toMatchObject({ code: 'SIGNER_NOT_YET_ELIGIBLE', context: { details: { reason: 'witness_signer_not_signed' } } });
    expect(toHttp(new DelegationRefusedError('already_delegated'), 'r')).toMatchObject({ code: 'ENVELOPE_ILLEGAL_TRANSITION', statusCode: 409, context: { details: { reason: 'already_delegated' } } });
    expect(toHttp(new DelegationRefusedError('delegate_email_on_envelope'), 'r')).toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
    expect(toHttp(new SignerNotYetEligibleError('s'), 'r')).toBeInstanceOf(AramoError);
  });
});
