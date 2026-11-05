// M-A12 W1-C.2 — the text layer travels on the right transport: the sender route with
// workspace credentials; the signer route with the capability token in the body only.
import { createGuestSigningClient } from '../../../api/guestSigningClient';
import { recordingFetch, SIGNING_TOKEN } from '../../../testing/fakes';
import { workspaceWith } from '../../inbox/__tests__/fixtures';
import { senderTextLayer, signerTextLayer } from '../textLayerApi';

const BODY = { document_id: 'doc-1', pages: [{ page: 1, words: [{ t: 'Hello', x: 0.1, y: 0.1, w: 0.1, h: 0.02 }] }] };

describe('text layer transport', () => {
  it('sender: GET …/envelopes/{id}/documents/{doc}/text-layer with the Bearer session', async () => {
    const { net, workspace } = workspaceWith(() => ({ status: 200, body: BODY }));
    const l = await senderTextLayer(workspace, 'env-1', 'doc-1');
    expect(l.pages[0]?.words[0]?.t).toBe('Hello');
    expect(net.calls[0]).toMatchObject({ method: 'GET' });
    expect(net.calls[0]?.url).toMatch(/\/v1\/sign\/sender\/envelopes\/env-1\/documents\/doc-1\/text-layer$/);
    expect(net.calls[0]?.headers['Authorization']).toMatch(/^Bearer /);
  });

  it('signer: POST /v1/sign/signing/documents/{doc}/text-layer, token in the body, no credentials', async () => {
    const net = recordingFetch(() => ({ status: 200, body: BODY }));
    const session = createGuestSigningClient({ baseUrl: 'https://sign.aramo.ai', fetch: net.fetch }).open(SIGNING_TOKEN);
    await signerTextLayer(session, 'doc-1');
    expect(net.calls[0]?.method).toBe('POST');
    expect(net.calls[0]?.url).toMatch(/\/v1\/sign\/signing\/documents\/doc-1\/text-layer$/);
    expect(net.calls[0]?.body).toEqual({ token: SIGNING_TOKEN });
    expect(net.calls[0]?.headers['Authorization']).toBeUndefined();
  });
});
