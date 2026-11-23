// FIELD-PARITY-1 (Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED) §4 P1-5 —
// the host-agnostic model of the ONE web placement editor. A host (sign-web Prepare: an
// envelope's recipients; the console form Studio: a template's signer roles) maps its wire
// fields to PlacedField and back; the editor never sees a wire shape or an endpoint.
//
// Geometry is PDF-native, exactly what the hosts store: page index 0-based, points, origin
// bottom-left, (x, y) the box's lower-left corner. The editor works top-left only inside a
// gesture (geometry.ts toTopLeft / toPdf) and hands PDF-native boxes back.

import {
  FIELD_CATALOG,
  editableFieldSettings,
  fieldTypesFor,
  isFieldTypeKey,
  type DropdownChoice,
  type FieldCondition,
  type FieldOptions,
  type FieldSetting,
  type FieldSurface,
  type FieldTypeKey,
  type FieldValidation,
} from '@aramo/sign-fields';

import { type PdfPageInfo } from './geometry';

export type NameMode = 'SIGNER_PROFILE' | 'SIGNER_ENTERED';
export type GroupRule = 'SELECT_ONE' | 'SELECT_ANY';

/**
 * The per-field settings the editor can edit (the Sign SignatureField / documents
 * TemplateFieldDefinition setting columns: M-A6 §2 and FIELD-PARITY-1 P3 §6.2). Which ones a
 * field shows is the catalog's fieldSettingsOf(type) ∩ the host's capabilities. Text settings
 * use '' for "not set" (the wire's NULL); the hosts map them with settingsFromWire /
 * settingsToWire (lib/settings-wire.ts).
 */
export interface PlacementSettings {
  /** SIGNER_NAME — the server fills the signer's name (SIGNER_PROFILE, default), or the signer types it. */
  readonly nameMode: NameMode;
  /** S-1 — the field's label (a check box's caption; a radio button's option text). */
  readonly label: string;
  /** CHECKBOX / RADIO — group key ('' = no group; a RADIO always has one). */
  readonly groupKey: string;
  readonly groupRule: GroupRule;
  readonly minSelected: number | null;
  /** S-1 — the hint shown to the signer ('' = none). */
  readonly tooltip: string;
  /** S-2 — placeholder text ('' = none). */
  readonly placeholder: string;
  /** S-4 — shown, not editable by the signer (only together with senderFilled). */
  readonly readOnly: boolean;
  /** S-5 (dark) — the sender types the value before sending. */
  readonly senderFilled: boolean;
  /** S-5 — the sender's value of a sender-filled field ('' = none yet; a send host only). */
  readonly senderValue: string;
  /** S-6 — the validation preset ('' = none). */
  readonly validation: FieldValidation | '';
  /** S-7 — null = auto (the stamper fits the text); a number = fixed points. */
  readonly fontSize: number | null;
  /** S-9 — the stable data key ('' = none). */
  readonly dataName: string;
  /** The per-type options in the wire shape (DROPDOWN choices, NUMBER format, validation parameters). */
  readonly options: FieldOptions | null;
  /**
   * FIELD-PARITY-2 B-2 — "show only when" in the wire shape (null = always shown). Its
   * trigger_key is another field's id (the host's key: console field_key, sign-web field_key).
   */
  readonly condition: FieldCondition | null;
}

export const DEFAULT_SETTINGS: PlacementSettings = {
  nameMode: 'SIGNER_PROFILE',
  label: '',
  groupKey: '',
  groupRule: 'SELECT_ANY',
  minSelected: null,
  tooltip: '',
  placeholder: '',
  readOnly: false,
  senderFilled: false,
  senderValue: '',
  validation: '',
  fontSize: null,
  dataName: '',
  options: null,
  condition: null,
};

/** FIELD-PARITY-1 P3 — the types whose fields form groups (a check-box group; a radio group). */
export const GROUPED_TYPES: ReadonlySet<string> = new Set(['CHECKBOX', 'RADIO']);
export const isGroupedType = (type: string): boolean => GROUPED_TYPES.has(type);

/** The choices a new DROPDOWN starts with (the server refuses a dropdown without choices). */
export const NEW_DROPDOWN_CHOICES: readonly DropdownChoice[] = [
  { value: 'Option 1', label: 'Option 1' },
  { value: 'Option 2', label: 'Option 2' },
];

/** The group keys in use by grouped fields. */
export function groupKeysOf(fields: readonly Pick<PlacedField, 'type' | 'settings'>[]): Set<string> {
  return new Set(fields.filter((f) => isGroupedType(f.type)).map((f) => f.settings.groupKey.trim()).filter((k) => k.length > 0));
}

/** The first free `<base>_<n>` group key (n from 1). */
export function freeGroupKey(base: string, taken: ReadonlySet<string>): string {
  for (let n = 1; ; n += 1) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
}

/**
 * FIELD-PARITY-1 P3 — the settings a newly placed field starts with: a RADIO gets a group of its
 * own (the server needs one) and its first option text; a DROPDOWN gets two choices to edit.
 */
export function defaultSettingsFor(type: string, fields: readonly Pick<PlacedField, 'type' | 'settings'>[]): PlacementSettings {
  if (type === 'RADIO') return { ...DEFAULT_SETTINGS, groupKey: freeGroupKey('radio', groupKeysOf(fields)), groupRule: 'SELECT_ONE', label: 'Option 1' };
  if (type === 'DROPDOWN') return { ...DEFAULT_SETTINGS, options: { choices: NEW_DROPDOWN_CHOICES } };
  return DEFAULT_SETTINGS;
}

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
  /**
   * S-5 — the host can send the sender's value of a sender-filled field (sign-web Prepare: the
   * envelope API takes `value`; a template has no sender value). The sender-filled toggle itself
   * shows only when the host lists 'sender_filled' in `settings` (the server flag is on).
   */
  readonly senderValues?: boolean;
}

/** One place for a page position: the document and page within it. */
export interface PageRef {
  readonly docId: string;
  readonly page: number;
}

/**
 * The settings controls a field shows: the catalog's list ∩ the host's capabilities
 * (FIELD-PARITY-2 A-7 — @aramo/sign-fields editableFieldSettings, the one projection the app uses too).
 */
export function editableSettingsOf(type: string, caps: PlacementCapabilities): readonly FieldSetting[] {
  return editableFieldSettings(type, caps.settings);
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
