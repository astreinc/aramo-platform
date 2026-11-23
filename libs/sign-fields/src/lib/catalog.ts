// FIELD-PARITY-1 (Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED) §4 P1-1 —
// the ONE field catalog. One record per field type: its label and glyph, default size and
// required default (P1-0), value kind, who fills it, the settings it accepts, and the surfaces
// that accept it. Every field-type list in the repo is a projection of this table
// (fieldTypesFor); the database CHECKs and OpenAPI enums stay literal and are held equal to
// their projection by the catalog-parity test (apps/api/src/tests/field-catalog-parity.spec.ts).
//
// Phase 1 was a refactor: each surface flag recorded EXACTLY the set that surface accepted.
// Phase 3 (§6, rulings R-1, R-2, R-9) widens the send and template surfaces here: the profile
// types and ACKNOWLEDGEMENT join every send and template surface, and five new types (DATE,
// DROPDOWN, RADIO, NUMBER, MULTILINE_TEXT) join the Sign store and every send and template
// surface. The S2S / Sign API surface (sign_api_s2s) is NOT widened: its contract and mapper
// carry no settings, so it keeps its 7 types.

/** Where a field type may appear. */
export const FIELD_SURFACES = [
  /** The Sign SignatureField table (its field-type CHECK): every type an envelope may store. */
  'sign_store',
  /** The sender API (PUT …/fields) as authored from sign-web Prepare. */
  'send_web',
  /** The sender API (PUT …/fields) as authored from the Aramo Sign app. */
  'send_mobile',
  /** Service-to-service / Sign API envelope creation (envelope-field-mapper). */
  'sign_api_s2s',
  /** An engine field a sender may send back unchanged with its id (SenderFieldPassthrough). */
  'engine_passthrough',
  /** A platform fixed-form template (console Form Studio; fixed-forms.ts). */
  'template_fixed_form',
  /** A template field carried onto an envelope (sender-templates.service.ts). */
  'template_editable',
  /** documents."TemplateFieldDefinition" (its field-type CHECK): every type a template field row may hold. */
  'template_documents_store',
  /**
   * FIELD-PARITY-1 P3 (ruling R-9) — the types the documents template API (POST …/fields) accepts:
   * the store minus IMAGE, which is retired from authoring (existing rows stay readable).
   */
  'template_documents_authoring',
  /** A renderer-drawn signature block of a generated template. */
  'signature_block',
  /**
   * The deterministic field suggestions (FIELD-PARITY-1 P2-4, @aramo/sign-fields detectFields):
   * every type the detector proposes. Each editor still shows only its own palette's types.
   */
  'suggestion',
] as const;
export type FieldSurface = (typeof FIELD_SURFACES)[number];

/**
 * P1-6 — the one gated rule: allowed on the surface only while payments are available to the
 * tenant (sign.payments AVAILABLE, Connect configured, plan Professional / Enterprise).
 */
export const WHEN_PAYMENTS_AVAILABLE = 'when_payments_available';
/** `true`: always allowed. A surface left out of an entry does not accept the type. */
export type SurfaceRule = true | typeof WHEN_PAYMENTS_AVAILABLE;
export type FieldSurfaceRules = { readonly [S in FieldSurface]?: SurfaceRule };

export type FieldValueKind = 'signature_image' | 'text' | 'date' | 'boolean' | 'option' | 'number' | 'money' | 'image';
/** Who supplies the value (§6 S-5). A sender-filled field (the sender_filled setting) is the sender's. */
export type FieldFiller = 'signer' | 'server' | 'sender';
/**
 * The per-field settings (the Sign SignatureField / documents TemplateFieldDefinition setting
 * columns). FIELD-PARITY-1 P3 §6.2 adds: tooltip (S-1), placeholder (S-2), read_only (S-4),
 * sender_filled (S-5, dark), validation (S-6, with its parameters in options), font_size (S-7),
 * data_name (S-9) and options (the per-type options: DROPDOWN choices, NUMBER format, the
 * validation parameters). label (S-1) now applies to every type. required (S-3) is a column of
 * every field, not a setting.
 */
export type FieldSetting =
  | 'label'
  | 'tooltip'
  | 'placeholder'
  | 'read_only'
  | 'sender_filled'
  | 'validation'
  | 'font_size'
  | 'data_name'
  | 'options'
  | 'group_key'
  | 'group_rule'
  | 'min_selected'
  | 'name_mode'
  | 'payment_amount_minor'
  | 'payment_currency'
  /**
   * FIELD-PARITY-2 B-2 — "show only when" ({ trigger_key, when, values? }; field-conditions.ts).
   * Every signer type takes it (C-6: a SIGNATURE too); never PAYMENT nor a documents-only type.
   */
  | 'condition';

export interface FieldCatalogEntry {
  readonly key: string;
  readonly label: string;
  readonly glyph: string;
  /** P1-0 — the default size in PDF points (mobile's table, Client Rule Consolidation Appendix A row 36). */
  readonly width: number;
  readonly height: number;
  /** P1-0 — whether a newly placed field starts required (Appendix A row 37). */
  readonly required: boolean;
  readonly value_kind: FieldValueKind;
  readonly filled_by: FieldFiller;
  /** SIGNER_NAME: who fills it depends on its name_mode (default SIGNER_PROFILE: the server). */
  readonly filled_by_name_mode?: { readonly SIGNER_PROFILE: FieldFiller; readonly SIGNER_ENTERED: FieldFiller };
  /** M-A12 W1-C.4 — a text field the signer's own Sign profile pre-fills (the signer may edit). */
  readonly prefill?: 'signer_profile';
  /**
   * FIELD-PARITY-1 P3 T-5 — a boolean type drawn as a circle (RADIO: one option of an exactly-one
   * group), not the check-box square. Absent: a square.
   */
  readonly mark_shape?: 'circle';
  readonly settings: readonly FieldSetting[];
  readonly surfaces: FieldSurfaceRules;
}

// FIELD-PARITY-1 P3 §6.2 — which settings each kind of type takes. label, tooltip and data_name
// (S-1, S-9) apply to every type. The rest:
//   placeholder (S-2)        — types the signer types or picks into;
//   read_only, sender_filled — types whose value the sender may supply (S-4, S-5);
//   validation (S-6)         — TEXT (email, phone, us_zip, max_length), MULTILINE_TEXT (max_length),
//                              NUMBER (number_range), DATE (date_range);
//   font_size (S-7)          — types drawn as text on the executed PDF;
//   options                  — DROPDOWN (choices), NUMBER (format), and the validation parameters.
// FIELD-PARITY-2 B-2 — condition ("show only when") is the last setting of every type a signer
// has (COND); PAYMENT and the documents-only types take none.
const NAMED = ['label', 'tooltip', 'data_name'] as const;
const COND = 'condition' as const;
const CHECKBOX_SETTINGS = ['label', 'group_key', 'group_rule', 'min_selected', 'tooltip', 'data_name', 'read_only', 'sender_filled', COND] as const;
const PROFILE_SETTINGS = [...NAMED, 'placeholder', 'font_size', COND] as const;

// The surfaces shared by the six types every family has (the fixed-form intersection).
const SIX = {
  sign_store: true,
  send_web: true,
  send_mobile: true,
  sign_api_s2s: true,
  engine_passthrough: true,
  template_fixed_form: true,
  template_editable: true,
  template_documents_store: true,
  template_documents_authoring: true,
} as const;
// M-A12 W1-C.4 — the profile text types: sender-placed, signer-filled. FIELD-PARITY-1 P3 T-1 (R-1)
// — now on every template surface too; still not on S2S.
const PROFILE = {
  sign_store: true,
  send_web: true,
  send_mobile: true,
  engine_passthrough: true,
  template_fixed_form: true,
  template_editable: true,
  template_documents_store: true,
  template_documents_authoring: true,
} as const;
// FIELD-PARITY-1 P3 T-3..T-7 — the new types: every send and template surface; not S2S.
const PHASE3 = PROFILE;
// Documents-family types with no Sign equivalent (ruling R-9): CURRENCY and SIGNER_EMAIL are
// mapped when a template carries them onto an envelope (TEMPLATE_TYPE_MAPPING) and stay
// authorable for template data; IMAGE is retired from authoring (the store keeps it readable).
const DOCUMENTS_ONLY = { template_documents_store: true, template_documents_authoring: true } as const;
const RETIRED = { template_documents_store: true } as const;

/**
 * The catalog, in the Sign authoring order (the order SENDER_FIELD_TYPES and ALL_FIELD_TYPES
 * have always had), then the Phase 3 types, then the documents-only types.
 */
export const FIELD_CATALOG = {
  SIGNATURE: {
    key: 'SIGNATURE',
    label: 'Signature',
    glyph: '✍',
    width: 230,
    height: 50,
    required: true,
    value_kind: 'signature_image',
    filled_by: 'signer',
    settings: [...NAMED, COND],
    surfaces: { ...SIX, signature_block: true, suggestion: true },
  },
  SIGN_DATE: {
    key: 'SIGN_DATE',
    label: 'Sign date',
    glyph: '📅',
    width: 150,
    height: 22,
    required: true,
    value_kind: 'date',
    // Client Rule Consolidation C0-2 — stamped by the server when the signer completes.
    filled_by: 'server',
    settings: [...NAMED, 'font_size', COND],
    surfaces: { ...SIX, signature_block: true, suggestion: true },
  },
  INITIALS: {
    key: 'INITIALS',
    label: 'Initials',
    glyph: 'AB',
    width: 60,
    height: 30,
    required: true,
    value_kind: 'signature_image',
    filled_by: 'signer',
    settings: [...NAMED, COND],
    surfaces: { ...SIX, suggestion: true },
  },
  TEXT: {
    key: 'TEXT',
    label: 'Text',
    glyph: 'T',
    width: 230,
    height: 22,
    required: false,
    value_kind: 'text',
    filled_by: 'signer',
    settings: [...NAMED, 'placeholder', 'read_only', 'sender_filled', 'validation', 'font_size', 'options', COND],
    surfaces: { ...SIX, suggestion: true },
  },
  SIGNER_NAME: {
    key: 'SIGNER_NAME',
    label: 'Name',
    glyph: 'Aa',
    width: 200,
    height: 22,
    required: true,
    value_kind: 'text',
    // M-A6 §2 — SIGNER_PROFILE (the sender default) is filled by the server; SIGNER_ENTERED
    // (and a legacy engine field with no name_mode) is typed by the signer.
    filled_by: 'server',
    filled_by_name_mode: { SIGNER_PROFILE: 'server', SIGNER_ENTERED: 'signer' },
    settings: ['name_mode', ...NAMED, 'placeholder', 'font_size', COND],
    surfaces: { ...SIX, signature_block: true, suggestion: true },
  },
  CHECKBOX: {
    key: 'CHECKBOX',
    label: 'Checkbox',
    glyph: '☑',
    width: 18,
    height: 18,
    required: false,
    value_kind: 'boolean',
    filled_by: 'signer',
    settings: CHECKBOX_SETTINGS,
    surfaces: { ...SIX, suggestion: true },
  },
  FIRST_NAME: {
    key: 'FIRST_NAME',
    label: 'First name',
    glyph: 'Fn',
    width: 150,
    height: 22,
    required: true,
    value_kind: 'text',
    filled_by: 'signer',
    prefill: 'signer_profile',
    settings: PROFILE_SETTINGS,
    surfaces: PROFILE,
  },
  LAST_NAME: {
    key: 'LAST_NAME',
    label: 'Last name',
    glyph: 'Ln',
    width: 150,
    height: 22,
    required: true,
    value_kind: 'text',
    filled_by: 'signer',
    prefill: 'signer_profile',
    settings: PROFILE_SETTINGS,
    surfaces: PROFILE,
  },
  EMAIL: {
    key: 'EMAIL',
    label: 'Email',
    glyph: '@',
    width: 200,
    height: 22,
    required: true,
    value_kind: 'text',
    filled_by: 'signer',
    prefill: 'signer_profile',
    settings: PROFILE_SETTINGS,
    surfaces: { ...PROFILE, suggestion: true },
  },
  COMPANY: {
    key: 'COMPANY',
    label: 'Company',
    glyph: 'Co',
    width: 200,
    height: 22,
    required: true,
    value_kind: 'text',
    filled_by: 'signer',
    prefill: 'signer_profile',
    settings: PROFILE_SETTINGS,
    surfaces: { ...PROFILE, suggestion: true },
  },
  TITLE: {
    key: 'TITLE',
    label: 'Title',
    glyph: 'Ti',
    width: 200,
    height: 22,
    required: true,
    value_kind: 'text',
    filled_by: 'signer',
    prefill: 'signer_profile',
    settings: PROFILE_SETTINGS,
    surfaces: { ...PROFILE, suggestion: true },
  },
  ACKNOWLEDGEMENT: {
    key: 'ACKNOWLEDGEMENT',
    label: 'Acknowledgement',
    glyph: '✓',
    width: 400,
    height: 26,
    required: true,
    value_kind: 'boolean',
    filled_by: 'signer',
    settings: [...NAMED, COND],
    // M-A6 line 33 made it engine-only (S2S / Sign API, sent back unchanged by a sender).
    // FIELD-PARITY-1 P3 T-2 (ruling R-2, amends M-A6 line 33) — authorable in sends and templates.
    surfaces: { ...PHASE3, sign_api_s2s: true },
  },
  PAYMENT: {
    key: 'PAYMENT',
    label: 'Payment',
    glyph: '$',
    width: 160,
    height: 26,
    // Sign 1.14 — always required (the server).
    required: true,
    value_kind: 'money',
    // Filled by the server when the signer's payment succeeds (the receipt line).
    filled_by: 'server',
    settings: ['payment_amount_minor', 'payment_currency'],
    // P1-6 — send-only, and only while payments are available; never on a template surface.
    surfaces: { sign_store: true, send_web: WHEN_PAYMENTS_AVAILABLE, send_mobile: WHEN_PAYMENTS_AVAILABLE },
  },
  // ---- FIELD-PARITY-1 P3 §6.1 — the new types (T-3..T-7). Signer-filled; a sender-filled field
  // (S-5, dark) is the sender's. In a documents template a field of these types with no signer
  // role is template data the renderer prints (unchanged); with a signer role it is a Sign field.
  DATE: {
    key: 'DATE',
    label: 'Date',
    glyph: '📆',
    width: 150,
    height: 22,
    required: false,
    // T-3 — a chosen date (stored YYYY-MM-DD), drawn in the envelope's date format.
    value_kind: 'date',
    filled_by: 'signer',
    settings: [...NAMED, 'placeholder', 'read_only', 'sender_filled', 'validation', 'font_size', 'options', COND],
    surfaces: PHASE3,
  },
  DROPDOWN: {
    key: 'DROPDOWN',
    label: 'Dropdown',
    glyph: '▾',
    width: 180,
    height: 22,
    required: false,
    // T-4 — the author's choices (options.choices); the value is the chosen choice's value.
    value_kind: 'option',
    filled_by: 'signer',
    settings: [...NAMED, 'placeholder', 'read_only', 'sender_filled', 'font_size', 'options', COND],
    surfaces: PHASE3,
  },
  RADIO: {
    key: 'RADIO',
    label: 'Radio button',
    glyph: '◉',
    width: 18,
    height: 18,
    required: false,
    // T-5 — ONE option of a radio group: every RADIO field with the same group_key (one signer)
    // is a group whose rule is always SELECT_ONE (exactly one chosen when required, at most one
    // otherwise) — the check-box SELECT_ONE group rule, drawn as circles. Each box holds 'true'
    // (chosen) or 'false'; its label is the option's text.
    value_kind: 'boolean',
    mark_shape: 'circle',
    filled_by: 'signer',
    settings: ['label', 'group_key', 'group_rule', 'tooltip', 'data_name', 'read_only', 'sender_filled', COND],
    surfaces: PHASE3,
  },
  NUMBER: {
    key: 'NUMBER',
    label: 'Number',
    glyph: '#',
    width: 120,
    height: 22,
    required: false,
    // T-6 — a decimal (stored as its canonical text); options.format 'money' prints it as money
    // in options.currency (replaces the documents-family CURRENCY, ruling R-9).
    value_kind: 'number',
    filled_by: 'signer',
    settings: [...NAMED, 'placeholder', 'read_only', 'sender_filled', 'validation', 'font_size', 'options', COND],
    surfaces: PHASE3,
  },
  MULTILINE_TEXT: {
    key: 'MULTILINE_TEXT',
    label: 'Multi-line text',
    glyph: '¶',
    width: 230,
    height: 66,
    required: false,
    // T-7 — wraps inside its box (the P0-2 stamper); validation max_length caps it.
    value_kind: 'text',
    filled_by: 'signer',
    settings: [...NAMED, 'placeholder', 'read_only', 'sender_filled', 'validation', 'font_size', 'options', COND],
    surfaces: PHASE3,
  },
  // ---- documents-family only (documents."TemplateFieldDefinition"); the sender's template
  // data is rendered into the PDF before Sign sees it (§1.5). Ruling R-9: a signer field of
  // CURRENCY or SIGNER_EMAIL is mapped onto an envelope (TEMPLATE_TYPE_MAPPING); IMAGE is retired.
  CURRENCY: {
    key: 'CURRENCY',
    label: 'Currency',
    glyph: '¤',
    width: 120,
    height: 22,
    required: false,
    value_kind: 'money',
    filled_by: 'sender',
    settings: [],
    surfaces: DOCUMENTS_ONLY,
  },
  IMAGE: {
    key: 'IMAGE',
    label: 'Image',
    glyph: '▣',
    width: 160,
    height: 80,
    required: false,
    value_kind: 'image',
    filled_by: 'sender',
    settings: [],
    surfaces: RETIRED,
  },
  SIGNER_EMAIL: {
    key: 'SIGNER_EMAIL',
    label: 'Signer email',
    glyph: '@',
    width: 200,
    height: 22,
    required: true,
    value_kind: 'text',
    filled_by: 'server',
    settings: [],
    surfaces: DOCUMENTS_ONLY,
  },
} as const satisfies Readonly<Record<string, FieldCatalogEntry>>;

type Catalog = typeof FIELD_CATALOG;
/** Every catalog field type. */
export type FieldTypeKey = keyof Catalog;

/** The types a surface always accepts. */
export type FieldTypeOn<S extends FieldSurface> = {
  [K in FieldTypeKey]: Catalog[K]['surfaces'] extends { readonly [P in S]: true } ? K : never;
}[FieldTypeKey];
/** The types a surface accepts while payments are available (adds the gated ones). */
export type FieldTypeOnWhenAvailable<S extends FieldSurface> = {
  [K in FieldTypeKey]: Catalog[K]['surfaces'] extends { readonly [P in S]: SurfaceRule } ? K : never;
}[FieldTypeKey];

/** The catalog's types, in catalog order. */
export const FIELD_TYPE_KEYS = Object.keys(FIELD_CATALOG) as readonly FieldTypeKey[];

export interface SurfaceGate {
  readonly payments_available: boolean;
}

function ruleOf(type: FieldTypeKey, surface: FieldSurface): SurfaceRule | undefined {
  return (FIELD_CATALOG[type].surfaces as FieldSurfaceRules)[surface];
}

function allowed(type: FieldTypeKey, surface: FieldSurface, gate: SurfaceGate | undefined): boolean {
  const rule = ruleOf(type, surface);
  return rule === true || (rule === WHEN_PAYMENTS_AVAILABLE && gate?.payments_available === true);
}

/**
 * The projection: the types a surface accepts, in catalog order. Without a gate, only the
 * always-allowed types; with `{ payments_available }`, the gated ones too while available.
 */
export function fieldTypesFor<S extends FieldSurface>(surface: S): FieldTypeOn<S>[];
export function fieldTypesFor<S extends FieldSurface>(surface: S, gate: SurfaceGate): FieldTypeOnWhenAvailable<S>[];
export function fieldTypesFor(surface: FieldSurface, gate?: SurfaceGate): FieldTypeKey[] {
  return FIELD_TYPE_KEYS.filter((t) => allowed(t, surface, gate));
}

/** Whether `v` is a type the surface accepts (see fieldTypesFor for the gate). */
export function isFieldTypeOn<S extends FieldSurface>(surface: S, v: unknown): v is FieldTypeOn<S>;
export function isFieldTypeOn<S extends FieldSurface>(surface: S, v: unknown, gate: SurfaceGate): v is FieldTypeOnWhenAvailable<S>;
export function isFieldTypeOn(surface: FieldSurface, v: unknown, gate?: SurfaceGate): boolean {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(FIELD_CATALOG, v) && allowed(v as FieldTypeKey, surface, gate);
}

/** Whether the type is allowed on the surface only while payments are available (P1-6). */
export function isPaymentsGatedOn(type: FieldTypeKey, surface: FieldSurface): boolean {
  return ruleOf(type, surface) === WHEN_PAYMENTS_AVAILABLE;
}

export function isFieldTypeKey(v: unknown): v is FieldTypeKey {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(FIELD_CATALOG, v);
}

export interface FieldDefaults {
  /** Default size in PDF points. */
  readonly width: number;
  readonly height: number;
  /** Whether a newly placed field starts required (the sender may change it). */
  readonly required: boolean;
}

/** P1-0 — the one default-size and required-default table, for every catalog type. */
export const FIELD_DEFAULTS: Readonly<Record<FieldTypeKey, FieldDefaults>> = Object.fromEntries(
  FIELD_TYPE_KEYS.map((t) => [t, { width: FIELD_CATALOG[t].width, height: FIELD_CATALOG[t].height, required: FIELD_CATALOG[t].required }]),
) as Record<FieldTypeKey, FieldDefaults>;

/** M-A12 W1-C.4 — the profile auto-fill text types (the signer's Sign profile pre-fills them). */
export type ProfileTextFieldType = {
  [K in FieldTypeKey]: Catalog[K] extends { readonly prefill: 'signer_profile' } ? K : never;
}[FieldTypeKey];
export const PROFILE_TEXT_FIELD_TYPES = FIELD_TYPE_KEYS.filter(
  (t) => (FIELD_CATALOG[t] as FieldCatalogEntry).prefill === 'signer_profile',
) as readonly ProfileTextFieldType[];

/** The settings a type accepts (an empty list: none). */
export function fieldSettingsOf(type: FieldTypeKey): readonly FieldSetting[] {
  return FIELD_CATALOG[type].settings;
}

/**
 * FIELD-PARITY-2 A-7 — the settings controls an editor shows for a field: the catalog's list for
 * its type ∩ the settings the host authors (in the catalog's order). ONE projection for the web
 * editor (@aramo/field-placement-web) and the app's settings sheet. An unknown type shows none.
 */
export function editableFieldSettings(type: string, hostSettings: readonly FieldSetting[]): readonly FieldSetting[] {
  if (!isFieldTypeKey(type)) return [];
  const allowed = new Set(hostSettings);
  return fieldSettingsOf(type).filter((s) => allowed.has(s));
}

/** The settings an envelope sender's editor authors besides sender-filled and read-only (never a payment's). */
const SENDER_EDITOR_SETTINGS: readonly FieldSetting[] = [
  'label',
  'group_key',
  'group_rule',
  'min_selected',
  'name_mode',
  'tooltip',
  'placeholder',
  'validation',
  'font_size',
  'data_name',
  'options',
];

/**
 * FIELD-PARITY-2 A-7 — the settings an envelope sender's editor authors (sign-web Prepare and the
 * app's Send flow): every setting but the PAYMENT amount and currency, with sender-filled and
 * read-only only while the server says they are on (sender_filled_fields_enabled, S-5).
 */
export function senderEditorSettings(senderFilledEnabled: boolean): readonly FieldSetting[] {
  return senderFilledEnabled ? [...SENDER_EDITOR_SETTINGS, 'read_only', 'sender_filled'] : SENDER_EDITOR_SETTINGS;
}

/**
 * FIELD-PARITY-1 P3 (ruling R-9) — a documents-family template type carried onto an envelope
 * as a Sign type: CURRENCY becomes NUMBER with the money format, SIGNER_EMAIL becomes EMAIL.
 * The mapped field keeps its geometry, role, required setting and its other settings.
 */
export const TEMPLATE_TYPE_MAPPING: Readonly<Record<string, { readonly field_type: FieldTypeKey; readonly options?: Readonly<Record<string, unknown>> }>> = {
  CURRENCY: { field_type: 'NUMBER', options: { format: 'money', currency: 'USD', decimals: 2 } },
  SIGNER_EMAIL: { field_type: 'EMAIL' },
};

/** FIELD-PARITY-1 P3 (ruling R-9) — types retired from authoring (stored rows stay readable). */
export const RETIRED_FIELD_TYPES = ['IMAGE'] as const satisfies readonly FieldTypeKey[];

/** FIELD-PARITY-1 P3 T-5 — whether a boolean type is drawn as a circle (RADIO). */
export function isCircleMark(type: string): boolean {
  return isFieldTypeKey(type) && (FIELD_CATALOG[type] as FieldCatalogEntry).mark_shape === 'circle';
}
