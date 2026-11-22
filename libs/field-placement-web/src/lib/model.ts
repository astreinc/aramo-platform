// FIELD-PARITY-1 (Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED) §4 P1-5 —
// the host-agnostic model of the ONE web placement editor. A host (sign-web Prepare: an
// envelope's recipients; the console form Studio: a template's signer roles) maps its wire
// fields to PlacedField and back; the editor never sees a wire shape or an endpoint.
//
// Geometry is PDF-native, exactly what the hosts store: page index 0-based, points, origin
// bottom-left, (x, y) the box's lower-left corner. The editor works top-left only inside a
// gesture (geometry.ts toTopLeft / toPdf) and hands PDF-native boxes back.

import { FIELD_CATALOG, fieldSettingsOf, fieldTypesFor, isFieldTypeKey, type FieldSetting, type FieldSurface, type FieldTypeKey } from '@aramo/sign-fields';

import { type PdfPageInfo } from './geometry';

export type NameMode = 'SIGNER_PROFILE' | 'SIGNER_ENTERED';
export type GroupRule = 'SELECT_ONE' | 'SELECT_ANY';

/**
 * The per-field settings the editor can edit (the Sign SignatureField columns, M-A6 §2). Which
 * ones a field shows is the catalog's fieldSettingsOf(type) ∩ the host's capabilities.
 */
export interface PlacementSettings {
  /** SIGNER_NAME — the server fills the signer's name (SIGNER_PROFILE, default), or the signer types it. */
  readonly nameMode: NameMode;
  /** CHECKBOX — caption. */
  readonly label: string;
  /** CHECKBOX — group key ('' = no group). */
  readonly groupKey: string;
  readonly groupRule: GroupRule;
  readonly minSelected: number | null;
}

export const DEFAULT_SETTINGS: PlacementSettings = { nameMode: 'SIGNER_PROFILE', label: '', groupKey: '', groupRule: 'SELECT_ANY', minSelected: null };

/** One field on a page. */
export interface PlacedField {
  /** Stable id: the host's key (console field_key; sign-web stored id or a generated key). */
  readonly id: string;
  /** A catalog type, or a stored type the catalog does not know (kept locked). */
  readonly type: string;
  readonly docId: string;
  /** 0-based page index within the document. */
  readonly page: number;
  /** PDF points, bottom-left origin. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly required: boolean;
  /** The recipient / role that fills it; null = none (console: "No role", or prefilled). */
  readonly assignee: string | null;
  /** Console — a text field prefilled by a template variable instead of a role (null = none). */
  readonly binding: string | null;
  readonly settings: PlacementSettings;
  /**
   * M-A6 §2 (PrepareEditor.tsx:65-66 before P1-5) — a stored field of a type the host cannot
   * author (an engine-only ACKNOWLEDGEMENT, an API-placed PAYMENT): shown, never moved or
   * changed, may be deleted; the host sends it back exactly as stored.
   */
  readonly locked?: boolean;
  /** A stored field without a position (kept by the host, not drawn). */
  readonly hidden?: boolean;
}

/** A document the editor draws: its id, title and page sizes (points). */
export interface PlacementDocument {
  readonly id: string;
  readonly title: string;
  readonly pages: readonly PdfPageInfo[];
}

/** Who a field can belong to: a sign-web envelope recipient or a console signer role. */
export interface PlacementAssignee {
  readonly id: string;
  readonly label: string;
  /** Optional display colour (sign-web's recipient palette); otherwise a tone by position. */
  readonly color?: string;
}

/** Console — a template variable a field may be prefilled from. */
export interface PlacementPrefill {
  readonly key: string;
  readonly label: string;
}

/** What the host's API accepts; the editor shows only those controls. */
export interface PlacementCapabilities {
  /**
   * The settings the host's API stores. The console's template API stores none of them until
   * P1-3 merges (label / group / name_mode are hidden there until the flag is flipped).
   */
  readonly settings: readonly FieldSetting[];
  /** The types a host may prefill from a variable (console: TEXT). */
  readonly prefillTypes?: readonly string[];
  /** The host API's text limits (sign-web: @aramo/sign-client CHECKBOX_LABEL_MAX / CHECKBOX_GROUP_KEY_MAX). */
  readonly limits?: { readonly labelMax?: number; readonly groupKeyMax?: number };
}

/** One place for a page position: the document and page within it. */
export interface PageRef {
  readonly docId: string;
  readonly page: number;
}

/** The settings controls a field shows: the catalog's list ∩ the host's capabilities. */
export function editableSettingsOf(type: string, caps: PlacementCapabilities): readonly FieldSetting[] {
  if (!isFieldTypeKey(type)) return [];
  const allowed = new Set(caps.settings);
  return fieldSettingsOf(type).filter((s) => allowed.has(s));
}

export interface PaletteEntry {
  readonly type: FieldTypeKey;
  readonly label: string;
  readonly glyph: string;
  /** P1-0 — the catalog's default size (points) and required default. */
  readonly width: number;
  readonly height: number;
  readonly required: boolean;
}

export interface PaletteOptions {
  /** P1-6 — PAYMENT joins a send surface only while payments are available AND the host can author it. */
  readonly payments_available?: boolean;
  /** Host palette labels (e.g. the console calls SIGN_DATE "Date"); default the catalog label. */
  readonly labels?: Partial<Record<FieldTypeKey, string>>;
  /** Host palette order; types not listed follow in catalog order. */
  readonly order?: readonly FieldTypeKey[];
}

/**
 * The palette: exactly the catalog's projection for the surface (fieldTypesFor), with the
 * catalog's glyph, default size and required default, in the host's order.
 */
export function paletteFor(surface: FieldSurface, opts: PaletteOptions = {}): PaletteEntry[] {
  const types = fieldTypesFor(surface, { payments_available: opts.payments_available === true }) as FieldTypeKey[];
  const order = opts.order ?? [];
  const position = (t: FieldTypeKey): number => {
    const i = order.indexOf(t);
    return i < 0 ? order.length + types.indexOf(t) : i;
  };
  return [...types]
    .sort((a, b) => position(a) - position(b))
    .map((type) => {
      const c = FIELD_CATALOG[type];
      return { type, label: opts.labels?.[type] ?? c.label, glyph: c.glyph, width: c.width, height: c.height, required: c.required };
    });
}

/** The display label of any stored type (catalog label, host override, else the raw type). */
export function typeLabelOf(type: string, labels?: Partial<Record<FieldTypeKey, string>>): string {
  if (!isFieldTypeKey(type)) return type;
  return labels?.[type] ?? FIELD_CATALOG[type].label;
}
