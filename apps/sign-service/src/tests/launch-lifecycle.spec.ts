import { describe, expect, it, vi } from 'vitest';
import type { MailerPort } from '@aramo/mailer';
import type { DocumentSourceProviderPort, EnvelopeNotificationService, EsignRepository, EsignService, SessionContext } from '@aramo/sign';
import type { IdentityRepository } from '@aramo/identity';

import { MailerSigningNotificationAdapter, renderSigningNotification } from '../app/mailer-signing-notification.adapter.js';
import { EsignExpiryWorker } from '../app/esign-expiry.worker.js';
import { IdentitySenderDirectoryAdapter } from '../app/identity-sender-directory.adapter.js';
import { EsignSignerController } from '../app/esign-http.controller.js';

// Aramo Sign launch — sign-service side of product completeness: email content
// (escaped, per kind/audience, links only http(s)), the expiry worker, the
// tenant-checked sender directory, and the two new signer routes.

describe('MailerSigningNotificationAdapter', () => {
  it('escapes every dynamic value and carries the provider message id', async () => {
    const sent: { to: string; subject: string; html: string; text?: string }[] = [];
    const mailer: MailerPort = { send: async (m) => { sent.push(m); return { message_id: 'ses-123' }; } };
    const res = await new MailerSigningNotificationAdapter(mailer).notify({
      kind: 'SIGNATURE_REQUEST',
      to_email: 'a@x.test',
      to_name: '<img src=x onerror=alert(1)>',
      envelope_subject: 'Deal "A" & <B>',
      signing_url: 'https://sign.example.test/s/tok',
    });
    expect(res).toEqual({ delivered: true, provider_message_id: 'ses-123' });
    expect(sent[0]!.html).not.toContain('<img');
    expect(sent[0]!.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(sent[0]!.html).toContain('Deal &quot;A&quot; &amp; &lt;B&gt;');
    expect(sent[0]!.subject).toBe('Please sign: Deal "A" & <B>');
  });

  it('propagates a mailer failure so the caller records it FAILED', async () => {
    const mailer: MailerPort = { send: async () => { throw new Error('SES down'); } };
    await expect(new MailerSigningNotificationAdapter(mailer).notify({ kind: 'SIGNATURE_VOIDED', to_email: 'a@x.test', to_name: 'A', envelope_subject: 'S' })).rejects.toThrow('SES down');
  });

  it('renders the right action per kind and audience, and drops non-http links', () => {
    expect(renderSigningNotification({ kind: 'SIGNATURE_COMPLETED', to_email: 'a', to_name: 'A', envelope_subject: 'S', download_url: 'https://sign.x/d/t' }).action?.label).toBe('Download signed copy');
    expect(renderSigningNotification({ kind: 'SIGNATURE_COMPLETED', audience: 'SENDER', to_email: 'a', to_name: 'A', envelope_subject: 'S', console_url: 'https://esign.x/sign/envelopes/1' }).action?.label).toBe('View in Aramo Sign');
    expect(renderSigningNotification({ kind: 'SIGNATURE_REQUEST', to_email: 'a', to_name: 'A', envelope_subject: 'S', signing_url: 'javascript:alert(1)' }).action).toBeUndefined();
    const declined = renderSigningNotification({ kind: 'SIGNATURE_DECLINED', audience: 'SENDER', to_email: 'a', to_name: 'A', envelope_subject: 'S', reason: 'Signer 1: wrong rate' });
    expect(declined.lines.join(' ')).toContain('Signer 1: wrong rate');
  });
});

describe('EsignExpiryWorker', () => {
  it('expires due envelopes and notifies each one; a notification failure does not stop the sweep', async () => {
    const esign = { expireDueEnvelopes: vi.fn(async () => [{ tenant_id: 't', envelope_id: 'e1' }, { tenant_id: 't', envelope_id: 'e2' }]) } as unknown as EsignService;
    const notified: string[] = [];
    const notifications = {
      envelopeExpired: vi.fn(async (_t: string, id: string) => {
        if (id === 'e1') throw new Error('mail down');
        notified.push(id);
      }),
    } as unknown as EnvelopeNotificationService;
    const worker = new EsignExpiryWorker(esign, notifications);
    expect(await worker.tick(new Date('2026-10-18T00:00:00Z'))).toBe(2);
    expect(notifications.envelopeExpired).toHaveBeenCalledTimes(2);
    expect(notified).toEqual(['e2']);
  });

  it('a failing sweep reports 0 and does not throw', async () => {
    const esign = { expireDueEnvelopes: vi.fn(async () => { throw new Error('db down'); }) } as unknown as EsignService;
    const worker = new EsignExpiryWorker(esign, {} as EnvelopeNotificationService);
    await expect(worker.tick()).resolves.toBe(0);
  });
});

describe('IdentitySenderDirectoryAdapter', () => {
  const identity = (opts: { member: boolean; active: boolean }) =>
    ({
      findMembership: vi.fn(async () => (opts.member ? { id: 'm' } : null)),
      findUserById: vi.fn(async () => ({ id: 'u', email: 'sam@acme.test', display_name: 'Sam', is_active: opts.active })),
    }) as unknown as IdentityRepository;

  it('returns the contact of an active member of the envelope tenant', async () => {
    expect(await new IdentitySenderDirectoryAdapter(identity({ member: true, active: true })).findSender('t1', 'u')).toEqual({ email: 'sam@acme.test', name: 'Sam' });
  });
  it('never returns a contact across tenants, or for an inactive user', async () => {
    expect(await new IdentitySenderDirectoryAdapter(identity({ member: false, active: true })).findSender('t2', 'u')).toBeNull();
    expect(await new IdentitySenderDirectoryAdapter(identity({ member: true, active: false })).findSender('t1', 'u')).toBeNull();
  });
});

describe('EsignSignerController — launch routes', () => {
  const ctx: SessionContext = { session_id: 's1', tenant_id: 'TENANT-SECRET', envelope_id: 'e1', signer_id: 'sg1' };

  it('disclosure-text returns the current server-held version, text and hash', async () => {
    const service = { resolveSession: vi.fn(async () => ctx) } as unknown as EsignService;
    const res = await new EsignSignerController(service, {} as EsignRepository, {} as DocumentSourceProviderPort).disclosureText({ token: 't' }, 'r');
    expect(res.disclosure_version).toBe('v1');
    expect(res.text_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(res)).not.toContain('TENANT-SECRET');
  });

  it('executed returns the signed documents and certificate for a valid grant, without tenant id', async () => {
    const service = { resolveExecutedAccess: vi.fn(async () => ({ tenant_id: 'TENANT-SECRET', envelope_id: 'e1', signer_id: 'sg1' })) } as unknown as EsignService;
    const repo = {
      getEnvelopeFull: vi.fn(async () => ({ subject: 'MSA', completed_at: new Date('2026-10-18T10:00:00Z'), documents: [{ id: 'ed1', title: 'msa.pdf' }] })),
      listExecutedDocuments: vi.fn(async () => [{ envelope_document_id: 'ed1', executed_bytes: Buffer.from('%PDF') }]),
      getExecutionCertificate: vi.fn(async () => ({ certificate_bytes: Buffer.from('cert') })),
    } as unknown as EsignRepository;
    const res = await new EsignSignerController(service, repo, {} as DocumentSourceProviderPort).executed({ token: 'dl' }, 'r');
    expect(res.documents).toEqual([{ title: 'msa.pdf', content_type: 'application/pdf', executed_base64: Buffer.from('%PDF').toString('base64') }]);
    expect(res.certificate_base64).toBe(Buffer.from('cert').toString('base64'));
    expect(JSON.stringify(res)).not.toContain('TENANT-SECRET');
  });

  it('decline notifies after the decline is final; a notification failure still returns success', async () => {
    const service = { resolveSession: vi.fn(async () => ctx), decline: vi.fn(async () => undefined) } as unknown as EsignService;
    const notifications = { envelopeDeclined: vi.fn(async () => { throw new Error('mail down'); }) } as unknown as EnvelopeNotificationService;
    const res = await new EsignSignerController(service, {} as EsignRepository, {} as DocumentSourceProviderPort, notifications).decline({ token: 't', reason: 'no' }, 'r');
    expect(res).toEqual({ declined: true });
    expect(notifications.envelopeDeclined).toHaveBeenCalledWith('TENANT-SECRET', 'e1', 'sg1', 'no');
  });
});
