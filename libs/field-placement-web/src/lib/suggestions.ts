// FIELD-PARITY-1 (Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED) §5 P2-4 —
// "Suggestions" in the ONE web placement editor: the host fetches the detector's suggestions
// (sign-web: the Sign envelope route with detect=all; console: the fixed-form route) and maps them
// to PlacementSuggestion; the editor shows the pending ones as ghost fields, and an accepted
// ghost becomes an ordinary field through placeFields (accept-all is ONE undo step).
//
// Which ghosts are pending is the shared rule (@aramo/sign-fields pendingSuggestions, the same
// one the Aramo Sign app uses): a palette type, not dismissed, not already covered by a field.

import { FIELD_DEFAULTS, isFieldTypeKey, pendingSuggestions } from '@aramo/sign-fields';

import { placeFields, type Command } from './editor-state';
import { type PdfPageInfo } from './geometry';
import { DEFAULT_SETTINGS, type PageRef, type PlacedField } from './model';

/** One suggestion in the editor's frame (PDF-native: page 0-based, points, origin bottom-left). */
export interface PlacementSuggestion {
  /** Stable within one load (the host's index, e.g. `s12`). */
  readonly id: string;
  readonly type: string;
  readonly docId: string;
  readonly page: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** The detector's reason (`label:Title`, `underscore_line`, …). */
  readonly reason: string;
}

/** The wire suggestion both routes answer (Sign detect=all; console fixed-form). */
export interface WireSuggestion {
  readonly type: string;
  readonly page_number: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly reason?: string;
}

/** Maps one document's wire suggestions to the editor's (ids unique across documents). */
export function suggestionsFromWire(docId: string, wire: readonly WireSuggestion[], idPrefix = docId): PlacementSuggestion[] {
  return wire.map((s, i) => ({ id: `${idPrefix}:${i}`, type: s.type, docId, page: s.page_number, x: s.x, y: s.y, width: s.width, height: s.height, reason: s.reason ?? 'found' }));
}

/** The ghosts still offered: on a page the editor shows, a palette type, not dismissed, not covered. */
export function pendingGhosts(
  suggestions: readonly PlacementSuggestion[],
  fields: readonly PlacedField[],
  opts: { readonly types: readonly string[]; readonly dismissed: ReadonlySet<string>; readonly pageSize: (ref: PageRef) => PdfPageInfo | undefined },
): PlacementSuggestion[] {
  const onPage = suggestions.filter((s) => opts.pageSize({ docId: s.docId, page: s.page }) !== undefined);
  return pendingSuggestions(onPage, fields.filter((f) => f.hidden !== true), { types: opts.types, dismissed: opts.dismissed });
}

/**
 * The fields accepting `list` makes: each at its suggested box (kept inside its page), of its
 * type with the catalog's required default, for `assignee`; ids from the host's rule, in order.
 */
export function fieldsFromSuggestions(
  list: readonly PlacementSuggestion[],
  ctx: { readonly assignee: string | null; readonly fields: readonly PlacedField[]; readonly newId: (type: string, fields: readonly PlacedField[]) => string; readonly pageSize: (ref: PageRef) => PdfPageInfo | undefined },
): PlacedField[] {
  const out: PlacedField[] = [];
  for (const s of list) {
    const page = ctx.pageSize({ docId: s.docId, page: s.page });
    if (page === undefined || !isFieldTypeKey(s.type)) continue;
    const width = Math.min(s.width, page.width);
    const height = Math.min(s.height, page.height);
    const x = Math.max(0, Math.min(s.x, page.width - width));
    const y = Math.max(0, Math.min(s.y, page.height - height));
    const f: PlacedField = {
      id: ctx.newId(s.type, [...ctx.fields, ...out]),
      type: s.type,
      docId: s.docId,
      page: s.page,
      x,
      y,
      width,
      height,
      required: FIELD_DEFAULTS[s.type].required,
      assignee: ctx.assignee,
      binding: null,
      settings: DEFAULT_SETTINGS,
    };
    out.push(f);
  }
  return out;
}

/** Accept suggestions: ONE command (one undo entry) adding every field. */
export function acceptSuggestions(fields: readonly PlacedField[], label: string): Command {
  return placeFields(fields, label);
}
