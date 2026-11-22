// FIELD-PARITY-1 (Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED) §4 P1-1 —
// the ONE field catalog. One record per field type: its label and glyph, default size and
// required default (P1-0), value kind, who fills it, the settings it accepts, and the surfaces
// that accept it. Every field-type list in the repo is a projection of this table
// (fieldTypesFor); the database CHECKs and OpenAPI enums stay literal and are held equal to
// their projection by the catalog-parity test (apps/api/src/tests/field-catalog-parity.spec.ts).
//
// Phase 1 is a refactor: each surface flag records EXACTLY the set that surface accepts today.
// A surface is widened (Phase 3) by flipping a flag here, then the CHECK / enum the parity
// test names.

/** Where a field type may appear. */
export const FIELD_SURFACES = [
  /** sign."SignatureField" (its field-type CHECK): every type an envelope may store. */
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
  /** documents."TemplateFieldDefinition" (its field-type CHECK) and the documents template API. */
  'template_documents_store',
  /** A renderer-drawn signature block of a generated template. */
  'signature_block',
  /** The deterministic text-layer field suggestions. */
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
/** Who supplies the value (§6 S-5). */
export type FieldFiller = 'signer' | 'server' | 'sender';
/** The per-field settings a sender may set today (sign."SignatureField" columns). */
export type FieldSetting = 'label' | 'group_key' | 'group_rule' | 'min_selected' | 'name_mode' | 'payment_amount_minor' | 'payment_currency';

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
  readonly settings: readonly FieldSetting[];
  readonly surfaces: FieldSurfaceRules;
}

const CHECKBOX_SETTINGS = ['label', 'group_key', 'group_rule', 'min_selected'] as const;

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
} as const;
// M-A12 W1-C.4 — the profile text types: sender-placed, signer-filled; not on S2S or templates.
const PROFILE = { sign_store: true, send_web: true, send_mobile: true, engine_passthrough: true } as const;
// Documents-family types with no Sign equivalent (ruling R-9 maps or retires them in P1-4).
const DOCUMENTS_ONLY = { template_documents_store: true } as const;

/**
 * The catalog, in the Sign authoring order (the order SENDER_FIELD_TYPES and ALL_FIELD_TYPES
 * have always had), then the documents-only types.
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
    settings: [],
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
    settings: [],
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
    settings: [],
    surfaces: SIX,
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
    settings: [],
    surfaces: SIX,
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
    settings: ['name_mode'],
    surfaces: { ...SIX, signature_block: true },
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
    surfaces: SIX,
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
    settings: [],
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
    settings: [],
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
    settings: [],
    surfaces: PROFILE,
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
    settings: [],
    surfaces: PROFILE,
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
    settings: [],
    surfaces: PROFILE,
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
    settings: [],
    // M-A6 line 33 — engine-only: S2S / Sign API, and sent back unchanged by a sender.
    surfaces: { sign_store: true, sign_api_s2s: true, engine_passthrough: true },
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
  // ---- documents-family only (documents."TemplateFieldDefinition"); the sender's template
  // data is rendered into the PDF before Sign sees it (§1.5).
  MULTILINE_TEXT: {
    key: 'MULTILINE_TEXT',
    label: 'Multi-line text',
    glyph: '¶',
    width: 230,
    height: 66,
    required: false,
    value_kind: 'text',
    filled_by: 'sender',
    settings: [],
    surfaces: DOCUMENTS_ONLY,
  },
  DATE: {
    key: 'DATE',
    label: 'Date',
    glyph: '📆',
    width: 150,
    height: 22,
    required: false,
    value_kind: 'date',
    filled_by: 'sender',
    settings: [],
    surfaces: DOCUMENTS_ONLY,
  },
  NUMBER: {
    key: 'NUMBER',
    label: 'Number',
    glyph: '#',
    width: 120,
    height: 22,
    required: false,
    value_kind: 'number',
    filled_by: 'sender',
    settings: [],
    surfaces: DOCUMENTS_ONLY,
  },
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
    surfaces: DOCUMENTS_ONLY,
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
