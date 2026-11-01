import { describe, expect, it } from 'vitest';

import { DisabledQesSigningAdapter, QesProviderNotConfiguredError, type QesSigningPort } from '../lib/ports/qes-signing.port.js';
import { DisabledEstampAdapter, EstampProviderNotConfiguredError } from '../lib/ports/estamp.port.js';
import { QesWorkflowService } from '../lib/regulated/qes-workflow.service.js';
import { EstampWorkflowService } from '../lib/regulated/estamp-workflow.service.js';
import { assertQesSatisfied } from '../lib/regulated/qes-guard.js';
import { RegulatedSigningStateError, RegulatedSigningValidationError } from '../lib/regulated/regulated-errors.js';
import { SignatureFieldIncompleteError } from '../lib/domain/errors.js';
import type { PrismaService } from '../lib/prisma/prisma.service.js';
import type { EsignRepository } from '../lib/esign.repository.js';

// Feature-Parity §1.16 / §1.19 (Amendment A1) — with no vendor contracted the workflows
// stay dark: the disabled adapters refuse, and the send / completion guards hold.
const T = '11111111-1111-4111-8111-111111111111';
const E = '22222222-2222-4222-8222-222222222222';
const S = '33333333-3333-4333-8333-333333333333';

const noRepo = {} as EsignRepository;
function prisma(over: Record<string, unknown>): PrismaService {
  return over as unknown as PrismaService;
}

describe('disabled adapters', () => {
  it('refuse every QTSP call', async () => {
    const a = new DisabledQesSigningAdapter();
    expect(a.configured).toBe(false);
    expect(a.provider).toBe('disabled');
    await expect(a.beginIdentity()).rejects.toBeInstanceOf(QesProviderNotConfiguredError);
    await expect(a.completeIdentity()).rejects.toBeInstanceOf(QesProviderNotConfiguredError);
    await expect(a.beginSignature()).rejects.toBeInstanceOf(QesProviderNotConfiguredError);
    await expect(a.signHash()).rejects.toBeInstanceOf(QesProviderNotConfiguredError);
  });
  it('refuse every aggregator call', async () => {
    const a = new DisabledEstampAdapter();
    expect(a.configured).toBe(false);
    await expect(a.order()).rejects.toBeInstanceOf(EstampProviderNotConfiguredError);
    await expect(a.certificate()).rejects.toBeInstanceOf(EstampProviderNotConfiguredError);
  });
});

describe('QesWorkflowService (no QTSP)', () => {
  it('defaults to the disabled adapter when no port is bound', () => {
    expect(new QesWorkflowService(prisma({}), noRepo).providerConfigured).toBe(false);
  });
  it('refuses to require QES and to start the QTSP flow', async () => {
    const svc = new QesWorkflowService(prisma({}), noRepo);
    await expect(svc.setSignatureLevel({ tenant_id: T, envelope_id: E, signer_id: S, level: 'QES', actor_ref: S })).rejects.toBeInstanceOf(QesProviderNotConfiguredError);
    await expect(svc.beginIdentity({ tenant_id: T, envelope_id: E, signer_id: S }, 'https://sign.example/qes/callback')).rejects.toBeInstanceOf(QesProviderNotConfiguredError);
    await expect(svc.complete({ tenant_id: T, envelope_id: E, signer_id: S }, { state: 'x', code: 'y', redirect_uri: 'https://sign.example/qes/callback' })).rejects.toBeInstanceOf(QesProviderNotConfiguredError);
  });
  it('validates the signature level before anything else', async () => {
    const svc = new QesWorkflowService(prisma({}), noRepo);
    await expect(svc.setSignatureLevel({ tenant_id: T, envelope_id: E, signer_id: S, level: 'AES', actor_ref: S })).rejects.toBeInstanceOf(RegulatedSigningValidationError);
  });
  it('send guard: refuses an envelope with a QES signer, allows one without', async () => {
    const withQes = new QesWorkflowService(prisma({ signQesSignature: { count: async () => 1 } }), noRepo);
    await expect(withQes.assertSendable(T, E)).rejects.toBeInstanceOf(QesProviderNotConfiguredError);
    const without = new QesWorkflowService(prisma({ signQesSignature: { count: async () => 0 } }), noRepo);
    await expect(without.assertSendable(T, E)).resolves.toBeUndefined();
  });
  it('send guard: a configured QTSP lets a QES envelope be sent', async () => {
    const port = { ...new DisabledQesSigningAdapter(), provider: 'stub', configured: true } as unknown as QesSigningPort;
    const svc = new QesWorkflowService(prisma({ signQesSignature: { count: async () => 1 } }), noRepo, port);
    await expect(svc.assertSendable(T, E)).resolves.toBeUndefined();
  });
});

describe('assertQesSatisfied (completion guard)', () => {
  const tx = (state: string | null) => ({ signQesSignature: { findFirst: async () => (state === null ? null : { state }) } }) as unknown as Pick<PrismaService, 'signQesSignature'>;
  it('passes a signer without a QES requirement and a SIGNED one', async () => {
    await expect(assertQesSatisfied(tx(null), T, S)).resolves.toBeUndefined();
    await expect(assertQesSatisfied(tx('SIGNED'), T, S)).resolves.toBeUndefined();
  });
  it('refuses completion until the QES signature is SIGNED', async () => {
    for (const state of ['REQUIRED', 'IDENTITY_PROOFING_PENDING', 'AUTHORIZED', 'FAILED']) {
      const err = await assertQesSatisfied(tx(state), T, S).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SignatureFieldIncompleteError);
      expect((err as SignatureFieldIncompleteError).reason).toBe('qes_signature_pending');
    }
  });
});

describe('EstampWorkflowService (no aggregator)', () => {
  const order = {
    state_code: 'IN-KA',
    article_code: 'Article 5(J)',
    stamp_duty_amount_paise: 20000,
    consideration_amount_paise: null,
    first_party: 'A',
    second_party: 'B',
    purchaser: 'A',
    description: null,
  };
  it('refuses to order an e-stamp paper', async () => {
    const svc = new EstampWorkflowService(prisma({}), noRepo);
    expect(svc.providerConfigured).toBe(false);
    await expect(svc.request({ tenant_id: T, envelope_id: E, actor_ref: S, order })).rejects.toBeInstanceOf(EstampProviderNotConfiguredError);
  });
  function guard(live: Record<string, unknown> | null, firstDocId: string | null) {
    return new EstampWorkflowService(
      prisma({
        signEstampOrder: { findFirst: async () => live },
        envelopeDocument: { findFirst: async () => (firstDocId === null ? null : { id: firstDocId }) },
      }),
      noRepo,
    );
  }
  it('send guard: no live order passes', async () => {
    await expect(guard(null, 'd1').assertSendable(T, E)).resolves.toBeUndefined();
  });
  it('send guard: a live order must be attached, with its certificate first', async () => {
    const reasonOf = (p: Promise<void>) => p.then(() => 'ok', (e: unknown) => (e as RegulatedSigningStateError).reason);
    expect(await reasonOf(guard({ state: 'ORDERED', attached_document_id: null }, 'd1').assertSendable(T, E))).toBe('estamp_not_attached');
    expect(await reasonOf(guard({ state: 'ATTACHED', attached_document_id: null }, 'd1').assertSendable(T, E))).toBe('estamp_not_attached');
    expect(await reasonOf(guard({ state: 'ATTACHED', attached_document_id: 'cert' }, 'd1').assertSendable(T, E))).toBe('estamp_not_first');
    expect(await reasonOf(guard({ state: 'ATTACHED', attached_document_id: 'cert' }, 'cert').assertSendable(T, E))).toBe('ok');
  });
});
