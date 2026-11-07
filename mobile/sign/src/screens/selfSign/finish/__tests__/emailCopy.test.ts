// M-A14 R-2 — Email uses the device mail composer with the executed PDF attached and the
// document title as subject; with no mail account it falls back to the share sheet.
import { createGuestSigningClient } from '../../../../api/guestSigningClient';
import { BASE, workspaceWith } from '../../../../features/inbox/__tests__/fixtures';
import type { ShareTarget } from '../../../../features/share/shareCompleted';
import { emailCompleted, type EmailDeps, type MailComposerPort } from '../emailCopy';

const target: ShareTarget = { kind: 'sent', envelopeId: 'env-1', subject: 'Lease Agreement' };

function deps(mail: MailComposerPort, status = 200) {
  const { net, workspace } = workspaceWith((req) =>
    req.url.endsWith('/v1/sign/sender/envelopes/env-1/executed')
      ? status === 200
        ? { status, body: { documents: [{ title: 'Lease Agreement', executed_base64: 'JVBERi0=' }] } }
        : { status, body: { reason: 'not_ready', code: 'not_ready' } }
      : { status: 404, body: {} },
  );
  const files = {
    writeTemp: jest.fn(async (name: string) => `file:///cache/share/${name}`),
    remove: jest.fn(),
  };
  const sheet = { available: jest.fn(async () => true), open: jest.fn(async () => undefined) };
  const d: EmailDeps = {
    workspace,
    guest: createGuestSigningClient({ baseUrl: BASE, fetch: net.fetch }),
    files,
    sheet,
    mail,
  };
  return { d, files, sheet, net };
}

describe('emailCompleted', () => {
  it('mail unavailable → falls back to the share sheet', async () => {
    const mail = { available: jest.fn(async () => false), compose: jest.fn() };
    const { d, sheet, files } = deps(mail);
    const r = await emailCompleted(target, d);
    expect(r).toEqual({ kind: 'shared', files: 1 });
    expect(mail.compose).not.toHaveBeenCalled();
    expect(sheet.open).toHaveBeenCalledWith('file:///cache/share/Lease Agreement.pdf', {
      mimeType: 'application/pdf',
      dialogTitle: 'Lease Agreement',
    });
    expect(files.remove).toHaveBeenCalledWith('file:///cache/share/Lease Agreement.pdf');
  });

  it('a throwing availability check also falls back to share', async () => {
    const mail = { available: jest.fn(async () => Promise.reject(new Error('x'))), compose: jest.fn() };
    const { d, sheet } = deps(mail);
    expect((await emailCompleted(target, d)).kind).toBe('shared');
    expect(sheet.open).toHaveBeenCalledTimes(1);
  });

  it('mail available → composer with the PDF attached and the title as subject; temp file removed', async () => {
    const mail = { available: jest.fn(async () => true), compose: jest.fn(async () => 'sent' as const) };
    const { d, files, sheet, net } = deps(mail);
    expect(await emailCompleted(target, d)).toEqual({ kind: 'emailed' });
    expect(net.calls.map((c) => c.url)).toEqual([`${BASE}/v1/sign/sender/envelopes/env-1/executed`]);
    expect(mail.compose).toHaveBeenCalledWith({
      subject: 'Lease Agreement',
      attachments: ['file:///cache/share/Lease Agreement.pdf'],
    });
    expect(sheet.open).not.toHaveBeenCalled();
    expect(files.remove).toHaveBeenCalledWith('file:///cache/share/Lease Agreement.pdf');
  });

  it('cancelled composer → cancelled', async () => {
    const mail = { available: jest.fn(async () => true), compose: jest.fn(async () => 'cancelled' as const) };
    expect(await emailCompleted(target, deps(mail).d)).toEqual({ kind: 'cancelled' });
  });

  it('executed copy not ready (409) → refused with the not-ready message, composer not opened', async () => {
    const mail = { available: jest.fn(async () => true), compose: jest.fn() };
    const r = await emailCompleted(target, deps(mail, 409).d);
    expect(r).toEqual({ kind: 'refused', message: 'The signed copy isn’t ready yet.' });
    expect(mail.compose).not.toHaveBeenCalled();
  });

  it('no target → refused', async () => {
    const mail = { available: jest.fn(async () => true), compose: jest.fn() };
    expect((await emailCompleted(null, deps(mail).d)).kind).toBe('refused');
  });
});
