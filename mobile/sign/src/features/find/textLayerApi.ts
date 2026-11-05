// M-A12 W1-C.2 — the text layer behind Find (contract §2). Two transports, never mixed:
//   - sender (workspace Bearer): GET /v1/sign/sender/envelopes/{envelope_id}/documents/{document_id}/text-layer
//   - signer (guest capability token in the body, like POST /v1/sign/signing/source):
//     POST /v1/sign/signing/documents/{document_id}/text-layer (contract change C-1)
// The words are kept in memory only, never logged, stored or persisted.
import type { GuestSigningSession } from '../../api/guestSigningClient';
import type { TextLayer, TextLayerPage, TextLayerWord } from '../../api/m-a12-contract-types';
import { fillPath } from '../../api/types';
import type { WorkspaceClient } from '../../api/workspaceClient';

const SENDER_PATH = '/v1/sign/sender/envelopes/{envelope_id}/documents/{document_id}/text-layer';
const SIGNER_PATH = '/v1/sign/signing/documents/{document_id}/text-layer';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Keep only well-formed words; anything else is dropped (never trusted blindly). */
export function parseTextLayer(raw: unknown, documentId: string): TextLayer {
  const o = (raw ?? {}) as Record<string, unknown>;
  const pages: TextLayerPage[] = [];
  for (const p of Array.isArray(o['pages']) ? (o['pages'] as unknown[]) : []) {
    const po = (p ?? {}) as Record<string, unknown>;
    const page = num(po['page']);
    if (page === null || page < 1) continue;
    const words: TextLayerWord[] = [];
    for (const w of Array.isArray(po['words']) ? (po['words'] as unknown[]) : []) {
      const wo = (w ?? {}) as Record<string, unknown>;
      const t = wo['t'];
      const x = num(wo['x']);
      const y = num(wo['y']);
      const ww = num(wo['w']);
      const h = num(wo['h']);
      if (typeof t !== 'string' || x === null || y === null || ww === null || h === null) continue;
      words.push({ t, x, y, w: ww, h });
    }
    pages.push({ page, words });
  }
  return { document_id: typeof o['document_id'] === 'string' ? o['document_id'] : documentId, pages };
}

export async function senderTextLayer(
  workspace: WorkspaceClient,
  envelopeId: string,
  documentId: string,
): Promise<TextLayer> {
  const r = await workspace.request<unknown>({
    method: 'GET',
    path: fillPath(SENDER_PATH, { envelope_id: envelopeId, document_id: documentId }),
  });
  return parseTextLayer(r.data, documentId);
}

export async function signerTextLayer(
  session: GuestSigningSession,
  documentId: string,
): Promise<TextLayer> {
  const raw = await session.postRaw<unknown>(
    fillPath(SIGNER_PATH, { document_id: documentId }) as `/v1/sign/signing/${string}`,
    {},
  );
  return parseTextLayer(raw, documentId);
}
