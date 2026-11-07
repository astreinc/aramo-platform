// M-A14 R-3 — "Auto suggest fields" (Option A: deterministic detection, no AI). The
// server reads the document's own text layer and proposes SIGNATURE and SIGN_DATE boxes
// next to signature / date labels:
//   GET /v1/sign/sender/envelopes/{envelope_id}/documents/{document_id}/field-suggestions
//   200 { suggestions: [{ type, page (1-based), x, y, width, height }] }
// Boxes are in the field-placement (WIRE) frame: points, origin at the page's
// bottom-left. Not yet in the generated types, so the response is parsed defensively and
// any failure is "no suggestions". The on/off choice is stored on this device only (G-7),
// default on.
import type { SecureKeyValue } from '../../auth/secureKeyValue';
import { fillPath } from '../../api/types';
import type { WorkspaceClient } from '../../api/workspaceClient';
import { randomId } from '../../util/ids';
import type { EditorField } from '../editor/editorReducer';
import { clampBox, wireToEditor, type PageSize } from '../editor/geometry';
import { SELF_KEY, type SelfDoc } from './selfSignModel';

const PATH = '/v1/sign/sender/envelopes/{envelope_id}/documents/{document_id}/field-suggestions';

export type SuggestedType = 'SIGNATURE' | 'SIGN_DATE';

export interface FieldSuggestion {
  readonly type: SuggestedType;
  /** 1-based, as the server sends it. */
  readonly page: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The server caps suggestions at 6 per document; the app never shows more. */
export const MAX_SUGGESTIONS = 6;

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Only well-formed suggestions survive; anything else is dropped. */
export function parseSuggestions(raw: unknown): FieldSuggestion[] {
  const o = (raw ?? {}) as Record<string, unknown>;
  const list = Array.isArray(o['suggestions']) ? (o['suggestions'] as unknown[]) : [];
  const out: FieldSuggestion[] = [];
  for (const s of list) {
    const so = (s ?? {}) as Record<string, unknown>;
    const type = so['type'];
    const page = num(so['page']);
    const x = num(so['x']);
    const y = num(so['y']);
    const width = num(so['width']);
    const height = num(so['height']);
    if (type !== 'SIGNATURE' && type !== 'SIGN_DATE') continue;
    if (page === null || !Number.isInteger(page) || page < 1) continue;
    if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) continue;
    out.push({ type, page, x, y, width, height });
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out;
}

/** The suggestions for one uploaded document; [] on any failure (R-3). */
export async function fetchFieldSuggestions(
  workspace: WorkspaceClient,
  envelopeId: string,
  documentId: string,
): Promise<FieldSuggestion[]> {
  try {
    const r = await workspace.request<unknown>({
      method: 'GET',
      path: fillPath(PATH, { envelope_id: envelopeId, document_id: documentId }),
    });
    return parseSuggestions(r.data);
  } catch {
    return [];
  }
}

/** The suggestions as editor fields for the caller (EDITOR frame, 0-based pages). */
export function suggestionsToFields(
  doc: Pick<SelfDoc, 'key' | 'pages'>,
  suggestions: readonly FieldSuggestion[],
  newKey: () => string = randomId,
): EditorField[] {
  const out: EditorField[] = [];
  for (const s of suggestions) {
    const size: PageSize | undefined = doc.pages?.[s.page - 1];
    if (!size) continue;
    const box = clampBox(wireToEditor(s, size), size);
    out.push({
      key: newKey(),
      docKey: doc.key,
      page: s.page - 1,
      recipientKey: SELF_KEY,
      type: s.type,
      required: true,
      ...box,
    });
  }
  return out;
}

/** Every uploaded document's suggestions, in document order; never throws. */
export async function suggestFields(
  workspace: WorkspaceClient,
  envelopeId: string,
  docs: readonly SelfDoc[],
): Promise<EditorField[]> {
  const lists = await Promise.all(
    docs.map((d) => (d.serverId ? fetchFieldSuggestions(workspace, envelopeId, d.serverId) : Promise.resolve([]))),
  );
  return docs.flatMap((d, i) => suggestionsToFields(d, lists[i] ?? []));
}

// ── The device preference (G-7) ─────────────────────────────────────────────

export const AUTO_SUGGEST_KEY = 'aramo.sign.pref.auto_suggest_fields';

export const autoSuggestPref = {
  async get(kv: SecureKeyValue): Promise<boolean> {
    try {
      const v = await kv.getItem(AUTO_SUGGEST_KEY);
      return v === null ? true : v === '1';
    } catch {
      return true;
    }
  },
  set: (kv: SecureKeyValue, on: boolean) => kv.setItem(AUTO_SUGGEST_KEY, on ? '1' : '0'),
};
