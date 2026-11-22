// FIELD-PARITY-1 §5 P2-4 — "Find fields" in the Send flow's field editor. The server runs the
// deterministic detector (no model, no network beyond our own API) over an UPLOADED document:
//   GET /v1/sign/sender/envelopes/{envelope_id}/documents/{document_id}/field-suggestions?detect=all
//   200 { suggestions: [{ type, page (1-based), page_number, x, y, width, height, reason, confidence }],
//         skipped_pages }
// The same route (without detect) answers self-sign's M-A14 suggestions (selfSign/fieldSuggestions.ts),
// unchanged. Boxes are in the WIRE frame (points, origin bottom-left); they are converted to the
// EDITOR frame with each page's size. The response is parsed defensively; any failure is
// "no suggestions".
import { DETECT_LIMIT, isSuggestedFieldType } from '@aramo/sign-client';

import { fillPath } from '../../api/types';
import type { WorkspaceClient } from '../../api/workspaceClient';
import type { EditorSuggestion } from './editorReducer';
import { wireToEditor, type PageSize } from './geometry';

const PATH = '/v1/sign/sender/envelopes/{envelope_id}/documents/{document_id}/field-suggestions';

export interface WireSuggestion {
  readonly type: string;
  /** 0-based page index. */
  readonly page_number: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly reason: string;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Only well-formed suggestions of a suggestion type survive; at most DETECT_LIMIT. */
export function parseAllSuggestions(raw: unknown): WireSuggestion[] {
  const o = (raw ?? {}) as Record<string, unknown>;
  const list = Array.isArray(o['suggestions']) ? (o['suggestions'] as unknown[]) : [];
  const out: WireSuggestion[] = [];
  for (const s of list) {
    const so = (s ?? {}) as Record<string, unknown>;
    const type = so['type'];
    const page = num(so['page_number']);
    const x = num(so['x']);
    const y = num(so['y']);
    const width = num(so['width']);
    const height = num(so['height']);
    if (!isSuggestedFieldType(type)) continue;
    if (page === null || !Number.isInteger(page) || page < 0) continue;
    if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) continue;
    out.push({ type, page_number: page, x, y, width, height, reason: typeof so['reason'] === 'string' ? so['reason'] : 'found' });
    if (out.length >= DETECT_LIMIT) break;
  }
  return out;
}

/** One uploaded document's suggestions (detect=all); [] on any failure. */
export async function fetchSenderSuggestions(
  workspace: WorkspaceClient,
  envelopeId: string,
  documentId: string,
): Promise<WireSuggestion[]> {
  try {
    const r = await workspace.request<unknown>({
      method: 'GET',
      path: fillPath(PATH, { envelope_id: envelopeId, document_id: documentId }),
      query: { detect: 'all' },
    });
    return parseAllSuggestions(r.data);
  } catch {
    return [];
  }
}

/** WIRE suggestions → EDITOR suggestions for one document (a page it lacks is dropped). */
export function toEditorSuggestions(docKey: string, pages: readonly PageSize[], list: readonly WireSuggestion[]): EditorSuggestion[] {
  const out: EditorSuggestion[] = [];
  list.forEach((s, i) => {
    const size = pages[s.page_number];
    if (!size) return;
    const box = wireToEditor(s, size);
    out.push({ key: `${docKey}:${i}`, docKey, page: s.page_number, type: s.type, reason: s.reason, ...box });
  });
  return out;
}
