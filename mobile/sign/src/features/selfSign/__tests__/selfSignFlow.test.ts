// M-A12 W1-A — the self-sign backend sequence (contract §1 "Mobile flow"), end to end over
// the real workspace and guest transports against a recording fake server:
//   create(self) → upload → place fields (self recipient) → send → self-sign-session →
//   exchange + disclosure → accept → fill each field → complete.
// No recipient is ever sent by the client and no Recipients call is made.
import { createGuestSigningClient } from '../../../api/guestSigningClient';
import type { RecordedRequest } from '../../../testing/fakes';
import { SIGNING_TOKEN } from '../../../testing/fakes';
import type { EditorField } from '../../editor/editorReducer';
import { workspaceWith } from '../../inbox/__tests__/fixtures';
import { createSenderApi } from '../../send/senderApi';
import {
  acceptFillComplete,
  createAndUpload,
  createSelfEnvelope,
  NO_PROGRESS,
  sendAndOpen,
} from '../selfSignFlow';
import type { SelfContext, SelfDoc } from '../selfSignModel';

const PAGE = { width: 612, height: 792 };
const MARK = {
  dataUrl: 'data:image/png;base64,AAA',
  method: 'DRAWN' as const,
  value: 'data:image/png;base64,AAA',
};

function server() {
  let revision = 1;
  const detail = () => ({
    status: 200,
    headers: { etag: `"env-1.${revision}"` },
    body: {
      id: 'env-1',
      subject: 'Lease',
      status: 'DRAFT',
      editable: true,
      revision,
      routing_mode: 'PARALLEL',
      documents: [{ id: 'doc-srv', title: 'Lease' }],
      recipients: [{ id: 'r-self', name: 'Priya Raman', email: 'priya@example.com', status: 'PENDING', recipient_kind: 'SIGNER' }],
      fields: [],
    },
  });
  return (req: RecordedRequest) => {
    const path = req.url.replace('https://sign.aramo.ai', '');
    if (req.method === 'POST' && path === '/v1/sign/sender/envelopes') return { status: 201, body: { id: 'env-1' } };
    if (req.method === 'GET' && path === '/v1/sign/sender/envelopes/env-1') return detail();
    if (path === '/v1/sign/sender/envelopes/env-1/documents') {
      revision += 1;
      return { status: 201, body: { id: 'doc-srv', title: 'Lease', pages: [PAGE] } };
    }
    if (path.endsWith('/fields') || path.endsWith('/send')) {
      revision += 1;
      return detail();
    }
    if (path.endsWith('/self-sign-session'))
      return { status: 201, body: { token: SIGNING_TOKEN, signer_id: 'r-self', expires_at: '2026-11-05T12:00:00Z' } };
    if (path === '/v1/sign/signing/disclosure-text')
      return { status: 200, body: { disclosure_version: '1.0', text: 'Disclosure', text_sha256: 'a'.repeat(64), message: null } };
    if (path === '/v1/sign/signing/document')
      return {
        status: 200,
        body: {
          documents: [{ document_id: 'doc-srv', title: 'Lease', ordinal: 1 }],
          fields: [
            { field_id: 'f-date', document_id: 'doc-srv', field_type: 'SIGN_DATE', page_number: 0, x: 100, y: 792 - 300 - 22, width: 150, height: 22, required: true },
            { field_id: 'f-sig', document_id: 'doc-srv', field_type: 'SIGNATURE', page_number: 0, x: 100, y: 792 - 100 - 50, width: 230, height: 50, required: true },
            { field_id: 'f-co', document_id: 'doc-srv', field_type: 'COMPANY', page_number: 0, x: 100, y: 792 - 400 - 22, width: 200, height: 22, required: true },
            { field_id: 'f-name', document_id: 'doc-srv', field_type: 'SIGNER_NAME', page_number: 0, x: 100, y: 792 - 500 - 22, width: 200, height: 22, required: true, server_filled: true },
          ],
          message: null,
        },
      };
    if (path === '/v1/sign/signing/complete') return { status: 200, body: { envelope_status: 'COMPLETED' } };
    return { status: 200, body: {} };
  };
}

const field = (key: string, type: EditorField['type'], y: number, w = 200, h = 22): EditorField => ({
  key,
  docKey: 'a',
  page: 0,
  recipientKey: 'self',
  type,
  x: 100,
  y,
  width: w,
  height: h,
  required: true,
  ...(type === 'SIGNER_NAME' ? { nameMode: 'SIGNER_PROFILE' as const } : {}),
});

const ctx: SelfContext = {
  profile: { display_name: 'Priya Raman', company: 'Northwind' },
  email: 'priya@example.com',
  fallbackName: '',
  dateFormat: 'MM/DD/YYYY',
  adopted: { SIGNATURE: MARK },
  today: new Date(2026, 10, 5),
};

describe('self-sign sequence', () => {
  it('create(self) → upload → fields → send → session → disclosure → fill → complete', async () => {
    const { net, workspace } = workspaceWith(server());
    const deps = {
      api: createSenderApi(workspace),
      createSelf: createSelfEnvelope(workspace),
      openSession: (token: string) => createGuestSigningClient({ baseUrl: 'https://sign.aramo.ai', fetch: net.fetch }).open(token),
      sleep: async () => undefined,
    };
    const docs: SelfDoc[] = [
      { key: 'a', title: 'Lease', filename: 'lease.pdf', base64: 'JVBERi0xLjQ=', pages: [PAGE], serverId: null },
    ];
    const up = await createAndUpload(deps, NO_PROGRESS, docs, 'Lease');
    expect(up.progress).toMatchObject({ envelopeId: 'env-1', signerId: 'r-self', sent: false });
    expect(up.docs[0]?.serverId).toBe('doc-srv');

    const fields = [
      field('sig', 'SIGNATURE', 100, 230, 50),
      field('date', 'SIGN_DATE', 300, 150),
      field('co', 'COMPANY', 400),
      field('name', 'SIGNER_NAME', 500),
    ];
    const opened = await sendAndOpen(deps, up.progress, fields, up.docs, 'Lease');
    expect(opened.progress.sent).toBe(true);
    expect(opened.disclosure.disclosure_version).toBe('1.0');

    const done = await acceptFillComplete(opened.session, opened.disclosure, fields, up.docs, ctx, { co: 'Acme' });
    expect(done.envelopeStatus).toBe('COMPLETED');

    const seq = net.calls.map((c) => `${c.method} ${c.url.replace('https://sign.aramo.ai', '')}`);
    expect(seq).toEqual([
      'POST /v1/sign/sender/envelopes',
      'GET /v1/sign/sender/envelopes/env-1',
      'POST /v1/sign/sender/envelopes/env-1/documents',
      'GET /v1/sign/sender/envelopes/env-1',
      'PUT /v1/sign/sender/envelopes/env-1/fields',
      'POST /v1/sign/sender/envelopes/env-1/send',
      'POST /v1/sign/sender/envelopes/env-1/self-sign-session',
      'POST /v1/sign/signing/exchange',
      'POST /v1/sign/signing/disclosure-text',
      'POST /v1/sign/signing/disclosure',
      'POST /v1/sign/signing/document',
      'POST /v1/sign/signing/fields/f-date/fill',
      'POST /v1/sign/signing/fields/f-sig/fill',
      'POST /v1/sign/signing/fields/f-co/fill',
      'POST /v1/sign/signing/complete',
    ]);
    // The client never names a recipient: the server makes the caller the one signer.
    expect(net.calls[0]?.body).toEqual({ subject: 'Lease', mode: 'self' });
    expect(seq.some((s) => s.includes('/recipients'))).toBe(false);
    const put = net.calls.find((c) => c.url.endsWith('/fields'));
    const wire = (put?.body?.['fields'] ?? []) as { signer_id: string; field_type: string }[];
    expect(wire.map((f) => f.signer_id)).toEqual(['r-self', 'r-self', 'r-self', 'r-self']);
    expect(wire.map((f) => f.field_type)).toEqual(['SIGNATURE', 'SIGN_DATE', 'COMPANY', 'SIGNER_NAME']);
    // Fill values: the adopted mark, the ISO date, the edited profile value; the
    // server-filled name is never sent. Signing calls carry the token, never a Bearer.
    const fill = (id: string) => net.calls.find((c) => c.url.endsWith(`/fields/${id}/fill`));
    expect(fill('f-sig')?.body).toEqual({ value: MARK.dataUrl, signature_method: 'DRAWN', token: SIGNING_TOKEN });
    expect(fill('f-date')?.body).toEqual({ value: '2026-11-05', token: SIGNING_TOKEN });
    expect(fill('f-co')?.body).toEqual({ value: 'Acme', token: SIGNING_TOKEN });
    expect(fill('f-name')).toBeUndefined();
    for (const c of net.calls.filter((x) => x.url.includes('/v1/sign/signing/')))
      expect(c.headers['Authorization']).toBeUndefined();
  });

  it('a retry after send never sends again', async () => {
    const { net, workspace } = workspaceWith(server());
    const deps = {
      api: createSenderApi(workspace),
      createSelf: createSelfEnvelope(workspace),
      openSession: (token: string) => createGuestSigningClient({ baseUrl: 'https://sign.aramo.ai', fetch: net.fetch }).open(token),
    };
    const progress = { envelopeId: 'env-1', etag: '"env-1.3"', signerId: 'r-self', sent: true, uploadKeys: {} };
    await sendAndOpen(deps, progress, [], [], 'Lease');
    expect(net.calls.some((c) => c.url.endsWith('/send') || c.url.endsWith('/fields'))).toBe(false);
    expect(net.calls[0]?.url).toMatch(/self-sign-session$/);
  });
});
