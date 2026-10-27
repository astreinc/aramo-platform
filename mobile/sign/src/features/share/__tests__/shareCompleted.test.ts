// Share a completed agreement (M-A4 §3.7): COMPLETED only, the authorized PDF only,
// written to cache, shared, then deleted; a link or token is never shared.
import { createGuestSigningClient } from '../../../api/guestSigningClient';
import { recordingFetch } from '../../../testing/fakes';
import { mergeAgreements } from '../../inbox/agreementsModel';
import { BASE, received, sent, workspaceWith } from '../../inbox/__tests__/fixtures';
import { ENVELOPE_STATUSES } from '../../inbox/types';
import {
  pdfFilename,
  receivedShareTarget,
  sentShareTarget,
  SHARE_NOT_ALLOWED,
  SHARE_NOT_READY,
  SHARE_UNAVAILABLE,
  shareCompleted,
  shareTargetFor,
  type ShareFilePort,
  type ShareSheetPort,
} from '../shareCompleted';

const TOKEN = 'd'.repeat(43);

function ports(opts: { available?: boolean; failOpen?: boolean } = {}) {
  const written: { name: string; base64: string; uri: string }[] = [];
  const removed: string[] = [];
  const opened: { uri: string; mimeType: string; dialogTitle: string }[] = [];
  const files: ShareFilePort = {
    writeTemp: async (name, base64) => {
      const uri = `file:///cache/aramo-share/x/${name}`;
      written.push({ name, base64, uri });
      return uri;
    },
    remove: (uri) => {
      removed.push(uri);
    },
  };
  const sheet: ShareSheetPort = {
    available: async () => opts.available ?? true,
    open: async (uri, o) => {
      if (opts.failOpen) throw new Error('share failed');
      opened.push({ uri, ...o });
    },
  };
  return { files, sheet, written, removed, opened };
}

const noGuest = { open: jest.fn() };

describe('who may share (decision)', () => {
  it('sender: COMPLETED only', () => {
    for (const s of ENVELOPE_STATUSES)
      expect(sentShareTarget('e1', 'MSA', s) !== null).toBe(s === 'COMPLETED');
  });

  it('recipient: COMPLETED and can_download only', () => {
    for (const s of ENVELOPE_STATUSES) {
      const yes = receivedShareTarget(
        received({ envelope_status: s, can_download: true, can_sign: false }),
      );
      expect(yes !== null).toBe(s === 'COMPLETED');
    }
    expect(
      receivedShareTarget(received({ envelope_status: 'COMPLETED', can_download: false })),
    ).toBeNull();
  });

  it('from a row: never for a local draft', () => {
    const local = mergeAgreements(null, null, [
      {
        localId: 'l',
        envelopeId: null,
        baseRevision: null,
        step: 'documents',
        updatedAt: '2026-10-01T00:00:00.000Z',
        payload: {},
      },
    ])[0]!;
    expect(shareTargetFor(local)).toBeNull();
    expect(shareTargetFor(mergeAgreements([sent('COMPLETED')], null)[0]!)?.kind).toBe('sent');
  });

  it('safe filenames ending in .pdf', () => {
    expect(pdfFilename('MSA / Northwind: v2.pdf')).toBe('MSA Northwind v2.pdf');
    expect(pdfFilename('   ', 1)).toBe('Agreement 2.pdf');
  });
});

describe('shareCompleted', () => {
  it('refuses without a target and touches nothing', async () => {
    const p = ports();
    const { net, workspace } = workspaceWith(() => ({ status: 200, body: {} }));
    expect(await shareCompleted(null, { workspace, guest: noGuest, ...p })).toEqual({
      kind: 'refused',
      message: SHARE_NOT_ALLOWED,
    });
    expect(net.calls).toHaveLength(0);
  });

  it('refuses when the device cannot share', async () => {
    const p = ports({ available: false });
    const { net, workspace } = workspaceWith(() => ({ status: 200, body: {} }));
    const r = await shareCompleted(sentShareTarget('e1', 'MSA', 'COMPLETED'), {
      workspace,
      guest: noGuest,
      ...p,
    });
    expect(r).toEqual({ kind: 'refused', message: SHARE_UNAVAILABLE });
    expect(net.calls).toHaveLength(0);
  });

  it('sender: downloads the executed PDF, shares the FILE, then deletes it', async () => {
    const p = ports();
    const { net, workspace } = workspaceWith(() => ({
      status: 200,
      body: {
        envelope_id: 'e1',
        documents: [
          {
            envelope_document_id: 'd1',
            title: 'MSA',
            executed_sha256: 'x',
            byte_size: 3,
            executed_base64: 'JVBE',
          },
        ],
        certificate: { certificate_sha256: 'y', byte_size: 3, certificate_base64: 'Q0VS' },
      },
    }));
    const r = await shareCompleted(sentShareTarget('e1', 'MSA', 'COMPLETED'), {
      workspace,
      guest: noGuest,
      ...p,
    });
    expect(r).toEqual({ kind: 'shared', files: 1 });
    expect(net.calls[0]!.method).toBe('GET');
    expect(net.calls[0]!.url).toMatch(/\/v1\/sign\/sender\/envelopes\/e1\/executed$/);
    expect(p.written).toEqual([
      { name: 'MSA.pdf', base64: 'JVBE', uri: 'file:///cache/aramo-share/x/MSA.pdf' },
    ]);
    expect(p.opened).toEqual([
      { uri: p.written[0]!.uri, mimeType: 'application/pdf', dialogTitle: 'MSA' },
    ]);
    expect(p.removed).toEqual([p.written[0]!.uri]);
  });

  it('the temp file is deleted even when the share sheet fails', async () => {
    const p = ports({ failOpen: true });
    const { workspace } = workspaceWith(() => ({
      status: 200,
      body: {
        envelope_id: 'e1',
        documents: [
          {
            envelope_document_id: 'd1',
            title: 'MSA',
            executed_sha256: 'x',
            byte_size: 3,
            executed_base64: 'JVBE',
          },
        ],
        certificate: null,
      },
    }));
    const r = await shareCompleted(sentShareTarget('e1', 'MSA', 'COMPLETED'), {
      workspace,
      guest: noGuest,
      ...p,
    });
    expect(r.kind).toBe('refused');
    expect(p.removed).toEqual([p.written[0]!.uri]);
  });

  it('recipient: signed-copy token read on the guest transport, discarded; never the link', async () => {
    const p = ports();
    const link = `https://sign.aramo.ai/d/${TOKEN}`;
    const { net, workspace } = workspaceWith(() => ({ status: 200, body: { download_url: link } }));
    const guestNet = recordingFetch(() => ({
      status: 200,
      body: {
        subject: 'Offer',
        completed_at: '2026-10-20T00:00:00.000Z',
        documents: [
          { title: 'Offer letter', content_type: 'application/pdf', executed_base64: 'JVBE' },
        ],
        certificate_base64: 'Q0VS',
      },
    }));
    const guest = createGuestSigningClient({ baseUrl: BASE, fetch: guestNet.fetch });
    const item = received({
      id: 'item-9',
      envelope_status: 'COMPLETED',
      can_download: true,
      can_sign: false,
      subject: 'Offer',
    });
    const r = await shareCompleted(receivedShareTarget(item), { workspace, guest, ...p });
    expect(r).toEqual({ kind: 'shared', files: 1 });
    expect(net.calls[0]!.method).toBe('POST');
    expect(net.calls[0]!.url).toMatch(/\/v1\/sign\/inbox\/item-9\/signed-copy$/);
    // the token goes only in the guest request body, with no workspace credentials
    expect(guestNet.calls[0]!.url).toMatch(/\/v1\/sign\/signing\/executed$/);
    expect(guestNet.calls[0]!.body).toEqual({ token: TOKEN });
    expect(guestNet.calls[0]!.headers.Authorization).toBeUndefined();
    // what is shared is a cache file of the PDF bytes; neither the link nor the token
    expect(p.written.map((w) => w.base64)).toEqual(['JVBE']);
    for (const o of p.opened) {
      expect(o.uri).toMatch(/^file:\/\//);
      expect(o.uri).not.toContain(TOKEN);
      expect(o.dialogTitle).not.toContain(TOKEN);
    }
    expect(p.removed).toEqual(p.written.map((w) => w.uri));
  });

  it('recipient: a 409 (not everyone signed) reads as not ready', async () => {
    const p = ports();
    const { workspace } = workspaceWith(() => ({
      status: 409,
      body: { error: { code: 'ENVELOPE_ILLEGAL_TRANSITION', message: 'x' } },
    }));
    const item = received({ envelope_status: 'COMPLETED', can_download: true, can_sign: false });
    const r = await shareCompleted(receivedShareTarget(item), { workspace, guest: noGuest, ...p });
    expect(r).toEqual({ kind: 'refused', message: SHARE_NOT_READY });
    expect(p.written).toHaveLength(0);
  });
});
