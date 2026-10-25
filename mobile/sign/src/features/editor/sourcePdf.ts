// The frozen source PDF of a draft document (GET …/documents/{documentId}/source), for
// the editor's page rendering and page sizes. The workspace client reads JSON bodies,
// so this one binary read builds the same workspace credentials itself: Bearer +
// X-Aramo-Consumer: sign, no cookies, one refresh-and-retry on 401 (M-A1). It reaches
// only this sender path, never a guest signing path (M-A2 §2.1).
import { clientError, errorFromBody } from '../../api/errors';
import { buildUrl, type FetchFn } from '../../api/http';
import { fillPath } from '../../api/types';
import { CONSUMER, CONSUMER_HEADER, type WorkspaceSessionPort } from '../../api/workspaceClient';

const SOURCE_PATH = '/v1/sign/sender/envelopes/{id}/documents/{documentId}/source';

export async function fetchSourcePdf(
  deps: {
    readonly baseUrl: string;
    readonly fetch: FetchFn;
    readonly session: WorkspaceSessionPort;
  },
  envelopeId: string,
  documentId: string,
): Promise<Uint8Array> {
  const url = buildUrl(deps.baseUrl, fillPath(SOURCE_PATH, { id: envelopeId, documentId }));
  const get = async (token: string): Promise<Response> => {
    try {
      return await deps.fetch(url, {
        method: 'GET',
        credentials: 'omit',
        headers: {
          Accept: 'application/pdf',
          Authorization: `Bearer ${token}`,
          [CONSUMER_HEADER]: CONSUMER,
        },
      });
    } catch {
      throw clientError('network_unavailable');
    }
  };
  const token = await deps.session.getAccessToken();
  if (!token) {
    deps.session.sessionExpired();
    throw clientError('session_expired', 401);
  }
  let res = await get(token);
  if (res.status === 401) {
    const fresh = await deps.session.refreshAccessToken();
    if (!fresh) {
      deps.session.sessionExpired();
      throw clientError('session_expired', 401);
    }
    res = await get(fresh);
    if (res.status === 401) {
      deps.session.sessionExpired();
      throw clientError('session_expired', 401);
    }
  }
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => undefined);
    throw errorFromBody(res.status, body, res.headers.get('Retry-After'));
  }
  return new Uint8Array(await res.arrayBuffer());
}
