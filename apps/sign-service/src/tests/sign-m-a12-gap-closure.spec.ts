import 'reflect-metadata';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import { formatSignDate, isProfileTextField, profileTextValueRefusal, PROFILE_TEXT_FIELD_TYPES } from '@aramo/sign';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';

import { AramoSignAllowanceGate } from '../app/aramo-sign-allowance.gate.js';
import { NativeAramoSignatureProvider } from '../app/native-aramo-signature.provider.js';
import { SavedDataPurgeService } from '../app/me/signature/saved-data-purge.service.js';
import { SignMeProfileService, appIssueSupportAddress, validateAppIssue, validateProfile, validateSettings } from '../app/me/profile/sign-me-profile.service.js';
import { FIELD_TYPES, SenderEnvelopeService, canSelfSignNow, envelopeModeOf } from '../app/sender/sender-envelope.service.js';
import { SenderTemplatesService } from '../app/sender/sender-templates.service.js';
import { DocumentTextLayerService, extractTextLayer, wordsOfRun } from '../app/text-layer/document-text-layer.service.js';

// Aramo-Sign-Mobile-Amendment-M-A12 (LOCKED) §4 — the unit-level tests for agent A's scope:
// self-sign mode (W1-A, D-1), Find in document (W1-C.2), profile field types (W1-C.4), the
// Sign profile / settings / app issues (W1-E) and template favorites (W1-F). The HTTP end to
// end cases (real Postgres) are in sign-mobile-contracts.integration.spec.ts.

const AUTH = { sub: '00000000-0000-4000-8000-0000000000a1', tenant_id: '00000000-0000-4000-8000-0000000000b1', scopes: ['sign:envelope:read', 'sign:envelope:create', 'sign:envelope:send'] } as unknown as AuthContextType;

function senderService(opts: { envelope_mode?: string; kind?: 'BUSINESS' | 'PERSONAL'; email?: string | null; settings?: { date_format: string; default_field_size: string } } = {}) {
  const detail = {
    source_application: 'aramo-sign',
    id: 'e1',
    subject: 'S',
    status: 'DRAFT',
    routing_mode: 'PARALLEL',
    envelope_mode: opts.envelope_mode ?? 'STANDARD',
    signer_date_format: null,
    revision: 1,
    message: null,
    allow_delegation: false,
    created_by: AUTH.sub,
    created_at: new Date(),
    sent_at: null,
    completed_at: null,
    declined_at: null,
    voided_at: null,
    expires_at: null,
    documents: [{ id: 'd1', title: 'Doc', ordinal: 1, content_type: 'application/pdf', byte_size: 1, source_sha256: 'sha', fields: [{ id: 'f1', signer_id: 's1', field_type: 'SIGNATURE', page_number: 0, x: 1, y: 1, width: 10, height: 10, required: true, filled_at: null, label: null, group_key: null, group_rule: null, min_selected: null, name_mode: null }], page_sizes: { pages: [{ width: 612, height: 792 }] } }],
    signers: [{ id: 's1', name: 'Me', email: 'me@x.test', status: 'PENDING', signing_order: 1, recipient_kind: 'SIGNER', bound_user_id: AUTH.sub, copy_delivery: null, witness_for_signer_id: null, signer_role: null, access_code_hash: null, access_code_locked_at: null, delegated_at: null, identity_verification_method: null, identity_verification_locked_at: null, viewed_at: null, signed_at: null, declined_at: null, decline_reason: null }],
  };
  const repo = {
    createDraft: vi.fn(async () => ({ id: 'e1', status: 'DRAFT', subject: 'S' })),
    replaceDraftRecipients: vi.fn(async () => []),
    updateDraft: vi.fn(async () => 2),
    getEnvelopeDetail: vi.fn(async () => detail),
    getDocument: vi.fn(async () => ({ id: 'd1', source_mode: 'OWNED', document_ref: null, document_revision_ref: null, source_object_key: 'k', source_sha256: 'sha-v1' })),
    reminderHistory: vi.fn(async () => []),
  };
  const provider = { sendEnvelope: vi.fn(async () => ({})), remindEnvelopeSigner: vi.fn() };
  const context = {
    assertCanAuthor: vi.fn(async () => undefined),
    assertCanAuthorTenant: vi.fn(async () => ({ id: AUTH.tenant_id, kind: opts.kind ?? 'BUSINESS', status: 'ACTIVE', created_at: new Date() })),
    tenantKind: vi.fn(async () => opts.kind ?? 'BUSINESS'),
  };
  const email = opts.email === undefined ? 'Me@X.test' : opts.email;
  const identity = { findUserById: vi.fn(async () => (email === null ? null : { id: AUTH.sub, email, display_name: 'Account Name', is_active: true, deactivated_at: null })) };
  const sources = { getSourcePdf: vi.fn(async () => new Uint8Array([1, 2, 3])) };
  const personal = { assertLegalAccepted: vi.fn(), ensureFreeSubscription: vi.fn(), assertRiskGate: vi.fn(), assertMaySend: vi.fn() };
  const userData = {
    getProfile: vi.fn(async () => ({ display_name: 'Profile Name' })),
    getSettings: vi.fn(async () => opts.settings ?? { date_format: 'MM/DD/YYYY', default_field_size: 'M' }),
  };
  const u = undefined;
  const svc = new SenderEnvelopeService(
    repo as never, provider as never, context as never, identity as never, {} as never, sources as never, {} as never,
    personal as never, u, u, u, u, u, u, u, u, u, u, userData as never,
  );
  return { svc, repo, provider, personal, userData, identity, detail };
}

describe('M-A12 W1-A — self-sign mode', () => {
  it('mode self: the server creates one SIGNER bound to the caller from the verified account email, named from the Sign profile', async () => {
    const { svc, repo } = senderService();
    const out = await svc.create(AUTH, { mode: 'self', subject: 'Lease', bound_user_id: 'someone-else' } as never, 'r');
    expect(out).toMatchObject({ id: 'e1', mode: 'self' });
    expect(repo.createDraft).toHaveBeenCalledWith(expect.objectContaining({ envelope_mode: 'SELF', created_by: AUTH.sub }));
    expect(repo.replaceDraftRecipients).toHaveBeenCalledWith({
      tenant_id: AUTH.tenant_id,
      envelope_id: 'e1',
      recipients: [{ name: 'Profile Name', email: 'Me@X.test', recipient_kind: 'SIGNER', copy_delivery: null, bound_user_id: AUTH.sub, witness_for_index: null }],
    });
  });

  it('client recipients are 422 self_sign_single_recipient; an unknown mode is 400; no verified email is 403', async () => {
    const { svc, repo } = senderService();
    await expect(svc.create(AUTH, { mode: 'self', recipients: [] }, 'r')).rejects.toMatchObject({ statusCode: 422, context: { details: { reason: 'self_sign_single_recipient' } } });
    await expect(svc.create(AUTH, { mode: 'solo' }, 'r')).rejects.toMatchObject({ statusCode: 400, context: { details: { reason: 'invalid_mode' } } });
    const unverified = senderService({ email: null });
    await expect(unverified.svc.create(AUTH, { mode: 'self' }, 'r')).rejects.toMatchObject({ statusCode: 403, context: { details: { reason: 'self_sign_email_unverified' } } });
    expect(repo.createDraft).not.toHaveBeenCalled();
    expect(unverified.repo.createDraft).not.toHaveBeenCalled();
  });

  it('a standard create is unchanged (mode standard, no recipient written)', async () => {
    const { svc, repo } = senderService();
    expect(await svc.create(AUTH, { subject: 'X' }, 'r')).toMatchObject({ mode: 'standard' });
    expect(repo.createDraft).toHaveBeenCalledWith({ tenant_id: AUTH.tenant_id, subject: 'X', created_by: AUTH.sub });
    expect(repo.replaceDraftRecipients).not.toHaveBeenCalled();
  });

  it('a later recipient change on a self envelope is 422; a reminder is 409 self_sign_no_reminders', async () => {
    const { svc, repo, provider } = senderService({ envelope_mode: 'SELF' });
    await expect(svc.replaceRecipients(AUTH, 'e1', { recipients: [{ name: 'B', email: 'b@x.test' }] }, 'r')).rejects.toMatchObject({ statusCode: 422, context: { details: { reason: 'self_sign_single_recipient' } } });
    expect(repo.replaceDraftRecipients).not.toHaveBeenCalled();
    await expect(svc.remind(AUTH, 'e1', {}, 'r')).rejects.toMatchObject({ statusCode: 409, context: { details: { reason: 'self_sign_no_reminders' } } });
    expect(provider.remindEnvelopeSigner).not.toHaveBeenCalled();
  });

  it('send (Personal, self): legal acceptance + risk gate, but not the allowance-bound young-account checks; the date format is stamped', async () => {
    const { svc, repo, personal, provider } = senderService({ envelope_mode: 'SELF', kind: 'PERSONAL', settings: { date_format: 'YYYY-MM-DD', default_field_size: 'S' } });
    const out = await svc.send(AUTH, 'e1', {}, 'r', { ip: '10.0.0.1' });
    expect(personal.assertLegalAccepted).toHaveBeenCalled();
    expect(personal.assertRiskGate).toHaveBeenCalled();
    expect(personal.assertMaySend).not.toHaveBeenCalled();
    expect(repo.updateDraft).toHaveBeenCalledWith(expect.objectContaining({ signer_date_format: 'YYYY-MM-DD', execution_mode: 'SINGLE_SIGNATURE' }));
    expect(provider.sendEnvelope).toHaveBeenCalledTimes(1);
    expect(out.mode).toBe('self');
  });

  it('send (Personal, standard) still runs the full Personal gate', async () => {
    const { svc, personal } = senderService({ kind: 'PERSONAL' });
    await svc.send(AUTH, 'e1', {}, 'r');
    expect(personal.assertMaySend).toHaveBeenCalledTimes(1);
  });

  it('envelope views carry mode, and can_self_sign_now follows the session rules', async () => {
    const { svc } = senderService({ envelope_mode: 'SELF' });
    const d = await svc.detail(AUTH, 'e1', 'r');
    expect(d.mode).toBe('self');
    expect(d.can_self_sign_now).toBe(false); // a draft
    const env = { status: 'SENT', routing_mode: 'PARALLEL', created_by: AUTH.sub, source_application: 'aramo-sign', signers: [{ id: 's1', status: 'PENDING', signing_order: 1, bound_user_id: AUTH.sub, recipient_kind: 'SIGNER', witness_for_signer_id: null }] };
    expect(canSelfSignNow(AUTH, env)).toBe(true);
    expect(canSelfSignNow(AUTH, { ...env, status: 'COMPLETED' })).toBe(false);
    expect(canSelfSignNow(AUTH, { ...env, source_application: 'aramo-ats' })).toBe(false);
    expect(canSelfSignNow({ ...AUTH, scopes: ['sign:envelope:read'] }, env)).toBe(false);
    expect(canSelfSignNow(AUTH, { ...env, signers: [{ ...env.signers[0]!, bound_user_id: 'other' }] })).toBe(false);
    expect(canSelfSignNow(AUTH, { ...env, signers: [{ ...env.signers[0]!, status: 'SIGNED' }] })).toBe(false);
    expect(canSelfSignNow(AUTH, { ...env, created_by: 'other' })).toBe(false);
    expect(canSelfSignNow({ ...AUTH, scopes: [...AUTH.scopes, 'sign:envelope:manage:all'] }, { ...env, created_by: 'other' })).toBe(true);
    // SEQUENTIAL — only on the caller's turn.
    const seq = { ...env, routing_mode: 'SEQUENTIAL', signers: [{ id: 's0', status: 'PENDING', signing_order: 1, bound_user_id: null, recipient_kind: 'SIGNER', witness_for_signer_id: null }, { ...env.signers[0]!, signing_order: 2 }] };
    expect(canSelfSignNow(AUTH, seq)).toBe(false);
    expect(envelopeModeOf({ envelope_mode: 'SELF' })).toBe('self');
    expect(envelopeModeOf({})).toBe('standard');
  });
});

describe('M-A12 D-1 — a self-sign envelope never uses the sign.envelopes allowance', () => {
  function provider(envelope_mode: string) {
    const repo = {
      getEnvelope: vi.fn(async () => ({ id: 'e1', created_by: AUTH.sub, envelope_mode })),
      getEnvelopeFull: vi.fn(async () => ({ id: 'e1', status: 'SENT', signers: [{ id: 's1', email: 'me@x.test', status: 'PENDING', recipient_kind: 'SIGNER' }] })),
    };
    const service = { send: vi.fn(async () => ({ envelope: {}, sessions: [], copies: [] })) };
    // The allowance would refuse (no sends left): a self envelope must not reach it.
    const allowance = {
      guardSend: vi.fn(async () => { throw new AramoError('ESIGN_ALLOWANCE_EXHAUSTED', 'used up', 409, { requestId: '' }); }),
      assertSubscribedForSelfSign: vi.fn(async () => undefined),
    };
    const notifier = { notify: vi.fn() };
    const notifications = { copiesIssued: vi.fn() };
    return { p: new NativeAramoSignatureProvider(repo as never, service as never, allowance as never, notifier as never, notifications as never), service, allowance, notifier, notifications };
  }

  it('SELF: sent at 0 sends left, with no allowance reservation, no invitation and no copy dispatch', async () => {
    const { p, service, allowance, notifier, notifications } = provider('SELF');
    await expect(p.sendEnvelope(AUTH.tenant_id, 'e1', AUTH.sub)).resolves.toMatchObject({ envelope_id: 'e1' });
    expect(service.send).toHaveBeenCalledTimes(1);
    expect(allowance.guardSend).not.toHaveBeenCalled();
    expect(notifier.notify).not.toHaveBeenCalled();
    expect(notifications.copiesIssued).not.toHaveBeenCalled();
  });

  it('SELF without an active subscription: 403 ESIGN_NOT_SUBSCRIBED, nothing sent (PO: same as web)', async () => {
    const { p, service, allowance } = provider('SELF');
    allowance.assertSubscribedForSelfSign.mockRejectedValueOnce(new AramoError('ESIGN_NOT_SUBSCRIBED', 'x', 403, { requestId: '' }));
    await expect(p.sendEnvelope(AUTH.tenant_id, 'e1', AUTH.sub)).rejects.toMatchObject({ code: 'ESIGN_NOT_SUBSCRIBED', statusCode: 403 });
    expect(service.send).not.toHaveBeenCalled();
    expect(allowance.guardSend).not.toHaveBeenCalled();
  });

  it('STANDARD: the allowance gate still decides (here: refused at the limit)', async () => {
    const { p, allowance, service } = provider('STANDARD');
    await expect(p.sendEnvelope(AUTH.tenant_id, 'e1', AUTH.sub)).rejects.toMatchObject({ code: 'ESIGN_ALLOWANCE_EXHAUSTED' });
    expect(allowance.guardSend).toHaveBeenCalledTimes(1);
    expect(service.send).not.toHaveBeenCalled();
  });
});

describe('AramoSignAllowanceGate.assertSubscribedForSelfSign — read-only (PO ruling on D-1)', () => {
  function gate(status: Record<string, unknown>) {
    const allowance = { getStatus: vi.fn(async () => status), reserve: vi.fn(), consume: vi.fn(), release: vi.fn(), resolveStale: vi.fn() };
    return { g: new AramoSignAllowanceGate(allowance as never, {} as never), allowance };
  }

  it('not subscribed (Business without a plan) → 403 ESIGN_NOT_SUBSCRIBED', async () => {
    const { g } = gate({ subscribed: false, allowance_key: 'sign.envelopes', state: 'NONE' });
    await expect(g.assertSubscribedForSelfSign('t1')).rejects.toMatchObject({ code: 'ESIGN_NOT_SUBSCRIBED', statusCode: 403 });
  });

  it('Business at 0 sends left, and Personal at its daily limit → allowed; nothing reserved or consumed', async () => {
    for (const status of [
      { subscribed: true, limit: 100, used: 100, remaining: 0, period_end: new Date() },
      { subscribed: true, limit: 5, used: 3, remaining: 2, daily: { limit: 1, used: 1, remaining: 0, next_available_at: new Date() }, period_end: new Date() },
    ]) {
      const { g, allowance } = gate(status);
      await expect(g.assertSubscribedForSelfSign('t1')).resolves.toBeUndefined();
      expect(allowance.reserve).not.toHaveBeenCalled();
      expect(allowance.consume).not.toHaveBeenCalled();
      expect(allowance.release).not.toHaveBeenCalled();
    }
  });
});

describe('M-A12 W1-C.4 — profile text field types', () => {
  it('are sender-authorable engine types, text-valued, with a value rule', () => {
    expect(PROFILE_TEXT_FIELD_TYPES).toEqual(['FIRST_NAME', 'LAST_NAME', 'EMAIL', 'COMPANY', 'TITLE']);
    for (const t of PROFILE_TEXT_FIELD_TYPES) {
      expect(FIELD_TYPES).toContain(t);
      expect(isProfileTextField({ field_type: t })).toBe(true);
    }
    expect(isProfileTextField({ field_type: 'TEXT' })).toBe(false);
    expect(profileTextValueRefusal('FIRST_NAME', 'Ann')).toBeNull();
    expect(profileTextValueRefusal('COMPANY', 'x'.repeat(201))).toBe('profile_field_value_invalid');
    expect(profileTextValueRefusal('EMAIL', 'ann@x.test')).toBeNull();
    expect(profileTextValueRefusal('EMAIL', 'ann at x')).toBe('email_field_value_invalid');
    expect(profileTextValueRefusal('TEXT', 'x'.repeat(5000))).toBeNull(); // other types unchanged
  });

  it('the stamped date formats', () => {
    const d = new Date(Date.UTC(2026, 10, 4));
    expect(formatSignDate(d, 'MM/DD/YYYY')).toBe('11/04/2026');
    expect(formatSignDate(d, 'DD/MM/YYYY')).toBe('04/11/2026');
    expect(formatSignDate(d, 'YYYY-MM-DD')).toBe('2026-11-04');
    expect(formatSignDate(d, null)).toBe('11/04/2026');
  });
});

describe('M-A12 W1-C.2 — Find in document (text layer)', () => {
  async function textPdf(rotate = 0): Promise<Uint8Array> {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([600, 800]);
    page.drawText('Hello Aramo world', { x: 60, y: 720, size: 20, font });
    if (rotate !== 0) page.setRotation(degrees(rotate));
    pdf.addPage([600, 800]); // an image-only (text-less) page
    return pdf.save();
  }

  it('extracts words with boxes normalised to 0..1, origin top-left; a text-less page has no words', async () => {
    const pages = await extractTextLayer(await textPdf());
    expect(pages.map((p) => p.page)).toEqual([1, 2]);
    expect(pages[1]?.words).toEqual([]);
    const words = pages[0]?.words ?? [];
    expect(words.map((w) => w.t)).toEqual(['Hello', 'Aramo', 'world']);
    const [hello, aramo] = words;
    expect(hello?.x).toBeCloseTo(60 / 600, 2);
    // Baseline at y=720 (bottom-left) → top of the glyph box ≈ (800 - 720 - 20) / 800 from the top.
    expect(hello?.y).toBeCloseTo((800 - 720 - 20) / 800, 2);
    expect(hello?.h).toBeCloseTo(20 / 800, 2);
    expect((aramo?.x ?? 0) > (hello?.x ?? 0) + (hello?.w ?? 0) - 0.001).toBe(true);
    for (const w of words) for (const v of [w.x, w.y, w.w, w.h]) expect(v >= 0 && v <= 1).toBe(true);
  });

  it('a rotated page still yields boxes inside the page', async () => {
    const pages = await extractTextLayer(await textPdf(90));
    const words = pages[0]?.words ?? [];
    expect(words.map((w) => w.t)).toEqual(['Hello', 'Aramo', 'world']);
    for (const w of words) for (const v of [w.x, w.y, w.w, w.h]) expect(v >= 0 && v <= 1).toBe(true);
    // Rotated 90°: the run is vertical, so each word is taller than wide.
    expect((words[0]?.h ?? 0) > (words[0]?.w ?? 0)).toBe(true);
  });

  it('wordsOfRun splits a run by character position and skips blanks', () => {
    const out = wordsOfRun('ab  cd', [10, 0, 0, -10, 0, 100], 60, 100, 100);
    expect(out.map((w) => w.t)).toEqual(['ab', 'cd']);
    expect(out[0]).toMatchObject({ x: 0, w: 0.2 });
    expect(out[1]).toMatchObject({ x: 0.4, w: 0.2 });
    expect(wordsOfRun('   ', [1, 0, 0, 1, 0, 0], 10, 100, 100)).toEqual([]);
  });

  it('caches per document version; an unreadable PDF is an empty layer and the content is never logged', async () => {
    const svc = new DocumentTextLayerService();
    const extract = vi.fn(async () => [{ page: 1, words: [{ t: 'secret', x: 0, y: 0, w: 0.1, h: 0.1 }] }]);
    svc.extract = extract;
    const load = vi.fn(async () => new Uint8Array([1]));
    await svc.forDocument('d1', 'v1', load);
    await svc.forDocument('d1', 'v1', load);
    expect(load).toHaveBeenCalledTimes(1);
    await svc.forDocument('d1', 'v2', load);
    expect(load).toHaveBeenCalledTimes(2);
    const bad = new DocumentTextLayerService();
    const warn = vi.spyOn((bad as unknown as { log: { warn: (m: string) => void } }).log, 'warn').mockImplementation(() => undefined);
    await expect(bad.forDocument('d9', 'v1', async () => new TextEncoder().encode('not a pdf secret-content'))).resolves.toEqual({ document_id: 'd9', pages: [] });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('secret');
  });

  it('the sender route uses the stored source sha256 as the version, after the visibility check', async () => {
    const { svc, repo } = senderService();
    const v = await svc.documentVersion(AUTH, 'e1', 'd1', 'r');
    expect(v.version).toBe('sha-v1');
    expect(repo.getEnvelopeDetail).toHaveBeenCalled();
    await expect(v.load()).resolves.toBeInstanceOf(Uint8Array);
  });
});

describe('M-A12 W1-E — profile, settings, app issues', () => {
  it('profile: display name 1..120; optional fields nullable, at most 200; ISO-2 country; E.164 phone; no unknown fields', () => {
    expect(validateProfile({ display_name: ' Ann ', country: 'gb', phone: '+44 20 7946 0958', title: '' }, 'r')).toEqual({
      display_name: 'Ann',
      title: null,
      company: null,
      address_line1: null,
      address_line2: null,
      city: null,
      region: null,
      postal_code: null,
      country: 'GB',
      phone: '+442079460958',
    });
    const reason = (body: unknown): string | undefined => {
      try {
        validateProfile(body, 'r');
        return undefined;
      } catch (e) {
        return ((e as AramoError).context as { details?: { reason?: string } }).details?.reason;
      }
    };
    expect(reason({})).toBe('invalid_display_name');
    expect(reason({ display_name: 'x'.repeat(121) })).toBe('invalid_display_name');
    expect(reason({ display_name: 'A', city: 'x'.repeat(201) })).toBe('invalid_profile_field');
    expect(reason({ display_name: 'A', country: 'USA' })).toBe('invalid_country');
    expect(reason({ display_name: 'A', phone: '0207946' })).toBe('invalid_phone');
    expect(reason({ display_name: 'A', ssn: '1' })).toBe('unknown_field');
    expect(reason([])).toBe('invalid_body');
  });

  it('settings: the three date formats and S/M/L only', () => {
    expect(validateSettings({ date_format: 'DD/MM/YYYY', default_field_size: 'L' }, 'r')).toEqual({ date_format: 'DD/MM/YYYY', default_field_size: 'L' });
    expect(() => validateSettings({ date_format: 'D/M/Y', default_field_size: 'M' }, 'r')).toThrow(AramoError);
    expect(() => validateSettings({ date_format: 'MM/DD/YYYY', default_field_size: 'XL' }, 'r')).toThrow(AramoError);
    expect(() => validateSettings({ date_format: 'MM/DD/YYYY', default_field_size: 'M', theme: 'dark' }, 'r')).toThrow(AramoError);
  });

  it('app issue: message 1..2000, the device fields, os ios|android, no extra properties', () => {
    const ok = { message: 'It crashed', app_version: '1.0.3', os: 'ios', os_version: '18.1', device_model: 'iPhone 15' };
    expect(validateAppIssue(ok, 'r')).toEqual({ ...ok, screen: null });
    expect(() => validateAppIssue({ ...ok, message: '' }, 'r')).toThrow(AramoError);
    expect(() => validateAppIssue({ ...ok, message: 'x'.repeat(2001) }, 'r')).toThrow(AramoError);
    expect(() => validateAppIssue({ ...ok, os: 'windows' }, 'r')).toThrow(AramoError);
    expect(() => validateAppIssue({ ...ok, token: 'abc' }, 'r')).toThrow(AramoError);
    expect(appIssueSupportAddress({})).toBeNull();
    expect(appIssueSupportAddress({ SIGN_APP_ISSUE_EMAIL: 'not an email' })).toBeNull();
    expect(appIssueSupportAddress({ SIGN_APP_ISSUE_EMAIL: 'support@aramo.test' })).toBe('support@aramo.test');
  });

  function profileService(count = 0, mailerFails = false) {
    const repo = {
      countAppIssuesSince: vi.fn(async () => count),
      oldestAppIssueSince: vi.fn(async () => new Date(Date.now() - 30 * 60_000)),
      recordAppIssue: vi.fn(async () => 'ref-1'),
      removeAppIssue: vi.fn(async () => undefined),
      getProfile: vi.fn(async () => null),
    };
    const identity = { findUserById: vi.fn(async () => ({ email: 'ann@x.test', display_name: 'Ann' })) };
    const mailer = { send: vi.fn(async (_m: { to: string; html: string; text: string }) => { if (mailerFails) throw new Error('ses down secret'); return { message_id: 'm' }; }) };
    return { svc: new SignMeProfileService(repo as never, identity as never, mailer as never), repo, mailer };
  }
  const issue = { message: 'Find <b>does</b> nothing', app_version: '1.0.3', os: 'android', os_version: '15', device_model: 'Pixel 8', screen: 'Signing' };

  it('report: off (503) without SIGN_APP_ISSUE_EMAIL; emailed to support (escaped) and 202 with it; 429 at 5 in the hour', async () => {
    const saved = process.env['SIGN_APP_ISSUE_EMAIL'];
    try {
      delete process.env['SIGN_APP_ISSUE_EMAIL'];
      await expect(profileService().svc.reportIssue(AUTH, issue, 'r')).rejects.toMatchObject({ statusCode: 503, context: { details: { reason: 'app_issues_unavailable' } } });
      process.env['SIGN_APP_ISSUE_EMAIL'] = 'support@aramo.test';
      const { svc, mailer, repo } = profileService();
      await expect(svc.reportIssue(AUTH, issue, 'r')).resolves.toEqual({ received: true, reference: 'ref-1' });
      expect(repo.recordAppIssue).toHaveBeenCalledWith(expect.objectContaining({ os: 'android', app_version: '1.0.3' }));
      const sent = mailer.send.mock.calls[0]?.[0] as { to: string; html: string; text: string };
      expect(sent.to).toBe('support@aramo.test');
      expect(sent.html).toContain('Find &lt;b&gt;does&lt;/b&gt; nothing');
      expect(sent.text).toContain('Pixel 8');
      const limited = profileService(5);
      await expect(limited.svc.reportIssue(AUTH, issue, 'r')).rejects.toMatchObject({ statusCode: 429, context: { details: { reason: 'app_issue_rate_limited' } } });
      expect(limited.mailer.send).not.toHaveBeenCalled();
      const failing = profileService(0, true);
      await expect(failing.svc.reportIssue(AUTH, issue, 'r')).rejects.toMatchObject({ statusCode: 503, context: { details: { reason: 'app_issue_delivery_failed' } } });
      expect(failing.repo.removeAppIssue).toHaveBeenCalledWith('ref-1');
    } finally {
      if (saved === undefined) delete process.env['SIGN_APP_ISSUE_EMAIL'];
      else process.env['SIGN_APP_ISSUE_EMAIL'] = saved;
    }
  });

  it('profile before the first save: the account name, nulls, the read-only account email', async () => {
    const { svc } = profileService();
    expect(await svc.getProfile(AUTH)).toMatchObject({ display_name: 'Ann', title: null, phone: null, email: 'ann@x.test', updated_at: null });
  });

  it('M-A8 deletion scope: account close removes the profile data too', async () => {
    const userData = { removeAllForUser: vi.fn(async () => ({ profiles: 1, settings: 1, app_issue_reports: 2, template_favorites: 3 })) };
    const purge = new SavedDataPurgeService({ removeAllForUser: vi.fn(async () => 0) } as never, { removeAllForUser: vi.fn(async () => 0) } as never, userData as never);
    await purge.purgeForAccountClose({ tenant_id: AUTH.tenant_id, user_id: AUTH.sub });
    expect(userData.removeAllForUser).toHaveBeenCalledWith(AUTH.tenant_id, AUTH.sub);
  });
});

describe('M-A12 W1-F — template favorites and ownership', () => {
  function templates() {
    const items = [
      { template_id: '11111111-1111-4111-8111-111111111111', owner_scope: 'TENANT' },
      { template_id: '22222222-2222-4222-8222-222222222222', owner_scope: 'PLATFORM' },
    ];
    const documents = { list: vi.fn(async () => ({ items, unavailable: [] })) };
    const gate = { assertAvailable: vi.fn() };
    const entitlements = { of: vi.fn(async () => ({ kind: 'INCLUDED' })) };
    const userData = {
      favoriteTemplateIds: vi.fn(async () => new Set(['22222222-2222-4222-8222-222222222222'])),
      addFavorite: vi.fn(async () => undefined),
      removeFavorite: vi.fn(async () => undefined),
    };
    const auth = { ...AUTH, scopes: [...AUTH.scopes, 'document_template:read'] } as AuthContextType;
    const svc = new SenderTemplatesService(documents as never, gate as never, {} as never, {} as never, {} as never, entitlements as never, userData as never);
    return { svc, userData, auth };
  }

  it('list items carry favorite (this user) and ownership from owner_scope (TENANT mine, PLATFORM shared)', async () => {
    const { svc, auth } = templates();
    const out = await svc.list(auth, 'r');
    expect(out.items.map((t) => [t.favorite, t.ownership])).toEqual([
      [false, 'mine'],
      [true, 'shared'],
    ]);
  });

  it('favorite: only a template in the caller list (404 otherwise); unfavorite is idempotent', async () => {
    const { svc, userData, auth } = templates();
    await svc.setFavorite(auth, '11111111-1111-4111-8111-111111111111', true, 'r');
    expect(userData.addFavorite).toHaveBeenCalledWith(AUTH.tenant_id, AUTH.sub, '11111111-1111-4111-8111-111111111111');
    await expect(svc.setFavorite(auth, '33333333-3333-4333-8333-333333333333', true, 'r')).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.setFavorite(auth, 'not-a-uuid', true, 'r')).rejects.toMatchObject({ statusCode: 400 });
    await svc.setFavorite(auth, '33333333-3333-4333-8333-333333333333', false, 'r');
    expect(userData.removeFavorite).toHaveBeenCalledTimes(1);
  });
});

describe('M-A12 W1-A — "Sign a document" from a template (mode self)', () => {
  const TPL = '44444444-4444-4444-8444-444444444444';
  function fromTemplate(opts: { roles?: Array<{ role_key: string; kind: 'SIGNER' | 'CC'; order: number }>; fields?: Array<{ role_key?: string }>; defs?: Array<{ signer_role: string | null; field_type: string }> } = {}) {
    const signing = opts.roles === undefined ? null : { roles: opts.roles.map((r) => ({ ...r, label: r.role_key })), routing_mode: 'PARALLEL' as const };
    const documents = {
      list: vi.fn(async () => ({ items: [{ template_id: TPL, owner_scope: 'TENANT', signing }], unavailable: [] })),
      render: vi.fn(async () => ({
        template_id: TPL,
        template_version_id: 'v1',
        version_number: 1,
        title: 'NDA',
        document_id: 'doc',
        document_revision_ref: 'rev',
        source_sha256: 'sha',
        signing,
        signature_fields: (opts.fields ?? [{}]).map((f, i) => ({ field_type: 'SIGNATURE', page_number: 0, x: 72, y: 100 + i * 50, width: 200, height: 40, ...f })),
        field_definitions: (opts.defs ?? []).map((d) => ({ field_key: 'k', page_number: 0, x: 72, y: 400, width: 100, height: 20, required: true, ...d })),
      })),
    };
    const repo = {
      createDraft: vi.fn(async () => ({ id: 'e1' })),
      addDraftCoreRefDocument: vi.fn(async () => ({ id: 'd1' })),
      replaceDraftRecipients: vi.fn(async () => [{ id: 's1' }]),
    };
    const envelopes = {
      selfRecipient: vi.fn(async () => ({ name: 'Me', email: 'me@x.test' })),
      replaceFields: vi.fn(async () => ({})),
      detail: vi.fn(async () => ({ id: 'e1', mode: 'self' })),
    };
    const auth = { ...AUTH, scopes: [...AUTH.scopes, 'document_template:read'] } as AuthContextType;
    const svc = new SenderTemplatesService(
      documents as never, { assertAvailable: vi.fn() } as never, { assertCanAuthor: vi.fn() } as never, repo as never, envelopes as never, { of: vi.fn(async () => ({ kind: 'INCLUDED' })) } as never,
    );
    return { svc, documents, repo, envelopes, auth };
  }

  it('binds the single signer role to the caller (SELF draft, server-made bound recipient, the role fields)', async () => {
    const t = fromTemplate({ roles: [{ role_key: 'client', kind: 'SIGNER', order: 1 }, { role_key: 'cc', kind: 'CC', order: 2 }], fields: [{ role_key: 'client' }], defs: [{ signer_role: 'client', field_type: 'SIGN_DATE' }] });
    const out = await t.svc.createEnvelope(t.auth, { template_id: TPL, mode: 'self' }, 'r');
    expect(out).toMatchObject({ mode: 'self', bound_role_key: 'client' });
    expect(t.repo.createDraft).toHaveBeenCalledWith(expect.objectContaining({ envelope_mode: 'SELF', template_ref: TPL }));
    expect(t.repo.replaceDraftRecipients).toHaveBeenCalledWith(expect.objectContaining({ recipients: [{ name: 'Me', email: 'me@x.test', recipient_kind: 'SIGNER', copy_delivery: null, bound_user_id: AUTH.sub, witness_for_index: null }] }));
    const fields = (t.envelopes.replaceFields.mock.calls[0] as unknown as [unknown, unknown, { fields: Array<{ field_type: string; signer_id: string }> }])[2].fields;
    expect(fields.map((f) => [f.field_type, f.signer_id])).toEqual([['SIGNATURE', 's1'], ['SIGN_DATE', 's1']]);
  });

  it('several signer roles but fields for one: the first needed role is bound; a template without roles binds its single block', async () => {
    const a = fromTemplate({ roles: [{ role_key: 'a', kind: 'SIGNER', order: 1 }, { role_key: 'b', kind: 'SIGNER', order: 2 }], fields: [{ role_key: 'b' }] });
    expect(await a.svc.createEnvelope(a.auth, { template_id: TPL, mode: 'self' }, 'r')).toMatchObject({ bound_role_key: 'b' });
    const plain = fromTemplate();
    expect(await plain.svc.createEnvelope(plain.auth, { template_id: TPL, mode: 'self' }, 'r')).toMatchObject({ bound_role_key: null });
    expect(plain.envelopes.replaceFields).toHaveBeenCalledTimes(1);
  });

  it('fields for two signer roles → 422 self_sign_single_recipient, before any envelope; given recipients → 422; unknown mode → 400', async () => {
    const two = fromTemplate({ roles: [{ role_key: 'a', kind: 'SIGNER', order: 1 }, { role_key: 'b', kind: 'SIGNER', order: 2 }], fields: [{ role_key: 'a' }, { role_key: 'b' }] });
    await expect(two.svc.createEnvelope(two.auth, { template_id: TPL, mode: 'self' }, 'r')).rejects.toMatchObject({ statusCode: 422, context: { details: { reason: 'self_sign_single_recipient' } } });
    expect(two.repo.createDraft).not.toHaveBeenCalled();
    const t = fromTemplate();
    for (const extra of [{ signer: { name: 'B', email: 'b@x.test' } }, { recipients: [] }, { cc: [] }]) {
      await expect(t.svc.createEnvelope(t.auth, { template_id: TPL, mode: 'self', ...extra }, 'r')).rejects.toMatchObject({ statusCode: 422 });
    }
    await expect(t.svc.createEnvelope(t.auth, { template_id: TPL, mode: 'solo' }, 'r')).rejects.toMatchObject({ statusCode: 400, context: { details: { reason: 'invalid_mode' } } });
    expect(t.documents.render).not.toHaveBeenCalled();
  });

  it('no verified account email → refused before the render', async () => {
    const t = fromTemplate();
    t.envelopes.selfRecipient.mockRejectedValueOnce(new AramoError('INSUFFICIENT_PERMISSIONS', 'x', 403, { requestId: 'r', details: { reason: 'self_sign_email_unverified' } }));
    await expect(t.svc.createEnvelope(t.auth, { template_id: TPL, mode: 'self' }, 'r')).rejects.toMatchObject({ statusCode: 403 });
    expect(t.documents.render).not.toHaveBeenCalled();
  });
});
