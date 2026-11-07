// The sender's field-authoring boundary. Directive §5, §7 C-13 set four tool types;
// M-A6 §2.1 (LOCKED) adds Name (SIGNER_NAME) and Checkbox (CHECKBOX), shown only when
// FEATURES.extraFieldTypes is on (M-A4 §2.2). ACKNOWLEDGEMENT stays engine-only:
// authoring never creates it and the server refuses it on PUT …/fields
// (`v1_field_type`). Signers still complete every engine type (§6).
// M-A12 W1-C.4 (LOCKED) adds the profile auto-fill types FIRST_NAME, LAST_NAME, EMAIL,
// COMPANY and TITLE (text-valued; the signer's own Sign profile pre-fills them at fill
// time and the signer may edit), shown while FEATURES.profileFieldTypes is on.
import { FEATURES } from '../../config/features';

export const BASE_FIELD_TYPES = ['SIGNATURE', 'INITIALS', 'SIGN_DATE', 'TEXT'] as const;
export const EXTRA_FIELD_TYPES = ['SIGNER_NAME', 'CHECKBOX'] as const;
export const PROFILE_FIELD_TYPES = ['FIRST_NAME', 'LAST_NAME', 'EMAIL', 'COMPANY', 'TITLE'] as const;
export const AUTHORING_FIELD_TYPES = [
  ...BASE_FIELD_TYPES,
  ...EXTRA_FIELD_TYPES,
  ...PROFILE_FIELD_TYPES,
] as const;

export type ProfileFieldType = (typeof PROFILE_FIELD_TYPES)[number];

const PROFILE_SET: ReadonlySet<string> = new Set(PROFILE_FIELD_TYPES);

/** M-A12 W1-C.4 — a text field the signer's Sign profile pre-fills. */
export function isProfileFieldType(v: unknown): v is ProfileFieldType {
  return typeof v === 'string' && PROFILE_SET.has(v);
}

export type AuthoringFieldType = (typeof AUTHORING_FIELD_TYPES)[number];

const AUTHORING_SET: ReadonlySet<string> = new Set(AUTHORING_FIELD_TYPES);

/** Every type the server accepts from a sender (a saved draft may hold any of them). */
export function isAuthoringFieldType(v: unknown): v is AuthoringFieldType {
  return typeof v === 'string' && AUTHORING_SET.has(v);
}

/** The tools the editor offers in this build. */
export function toolFieldTypes(
  extra: boolean = FEATURES.extraFieldTypes,
  profile: boolean = FEATURES.profileFieldTypes,
): readonly AuthoringFieldType[] {
  return [
    ...BASE_FIELD_TYPES,
    ...(extra ? EXTRA_FIELD_TYPES : []),
    ...(profile ? PROFILE_FIELD_TYPES : []),
  ];
}

/** M-A13 #2 — the tools shown before "More fields" (when there are more than 8). */
export const COMMON_FIELD_TYPES: readonly AuthoringFieldType[] = [
  'SIGNATURE',
  'INITIALS',
  'SIGN_DATE',
  'TEXT',
  'SIGNER_NAME',
  'CHECKBOX',
];
export const MAX_TOOLS_SHOWN = 8;

/** The tools on the panel: all of them, or the common ones (plus a picked other one). */
export function visibleTools(
  all: readonly AuthoringFieldType[],
  expanded: boolean,
  picked: AuthoringFieldType | null = null,
): readonly AuthoringFieldType[] {
  if (expanded || all.length <= MAX_TOOLS_SHOWN) return all;
  return all.filter((type) => COMMON_FIELD_TYPES.includes(type) || type === picked);
}

/** M-A13 #11 (R-5) — the base zoom is "Fit" (fit to width); larger levels keep their %. */
export function zoomLabel(zoom: number): { text: string; accessibility: string } {
  if (zoom <= 1) return { text: 'Fit', accessibility: 'Zoom fit to width' };
  const pct = Math.round(zoom * 100);
  return { text: `${pct}%`, accessibility: `Zoom ${pct} percent` };
}

/** M-A6 §2.2 — who supplies a Name field's value. The sender never does. */
export type NameMode = 'SIGNER_PROFILE' | 'SIGNER_ENTERED';
/** M-A6 §2.3 — a check-box group's rule. */
export type GroupRule = 'SELECT_ONE' | 'SELECT_ANY';

export const MAX_LABEL = 200;

export interface FieldTypeSpec {
  /** Tool and panel label. */
  readonly label: string;
  /** Lower-case form for the hint "Tap the page to place {type} for {name}". */
  readonly noun: string;
  /** Default size in PDF points (handoff §4.6). */
  readonly width: number;
  readonly height: number;
  /** Text and Checkbox start optional; every other type starts required. */
  readonly requiredByDefault: boolean;
}

export const FIELD_TYPE_SPECS: Readonly<Record<AuthoringFieldType, FieldTypeSpec>> = {
  SIGNATURE: {
    label: 'Signature',
    noun: 'signature',
    width: 230,
    height: 50,
    requiredByDefault: true,
  },
  INITIALS: { label: 'Initials', noun: 'initials', width: 60, height: 30, requiredByDefault: true },
  SIGN_DATE: { label: 'Date', noun: 'date', width: 150, height: 22, requiredByDefault: true },
  TEXT: { label: 'Text', noun: 'text', width: 230, height: 22, requiredByDefault: false },
  SIGNER_NAME: { label: 'Name', noun: 'name', width: 200, height: 22, requiredByDefault: true },
  CHECKBOX: {
    label: 'Checkbox',
    noun: 'a checkbox',
    width: 18,
    height: 18,
    requiredByDefault: false,
  },
  FIRST_NAME: { label: 'First name', noun: 'first name', width: 150, height: 22, requiredByDefault: true },
  LAST_NAME: { label: 'Last name', noun: 'last name', width: 150, height: 22, requiredByDefault: true },
  EMAIL: { label: 'Email', noun: 'email', width: 200, height: 22, requiredByDefault: true },
  COMPANY: { label: 'Company', noun: 'company', width: 200, height: 22, requiredByDefault: true },
  TITLE: { label: 'Title', noun: 'title', width: 200, height: 22, requiredByDefault: true },
};

/** M-A12 W1-E.2 — the user's default field size: the starting size of a placed field. */
export const FIELD_SIZE_SCALE = { S: 0.85, M: 1, L: 1.2 } as const;
export type FieldSizeKey = keyof typeof FIELD_SIZE_SCALE;

export function sizeScale(size: string | null | undefined): number {
  return size === 'S' || size === 'M' || size === 'L' ? FIELD_SIZE_SCALE[size] : 1;
}

/**
 * M-A14 R-6 — the Sign Document tool row: one horizontally scrolling row of circles in the
 * prototype's order (Signature, Initials, Date, Textbox, Name, First Name, Company, Title,
 * Checkbox), then Last Name and Email, which the backend supports (D-5). Replaces "More
 * fields" in self-sign only; the Send flow editor is unchanged. Types this build does not
 * author (FEATURES) are left out.
 */
export const SELF_SIGN_TOOLS: readonly {
  readonly type: AuthoringFieldType;
  readonly label: string;
  /** 24-unit stroke path. */
  readonly icon: string;
}[] = [
  { type: 'SIGNATURE', label: 'Signature', icon: 'M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16zM14 6l4 4M3 22h18' },
  { type: 'INITIALS', label: 'Initials', icon: 'M3 17 7 6l4 11M4.5 13h5M14 6h7l-7 11h7M3 21h18' },
  { type: 'SIGN_DATE', label: 'Date', icon: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4M8 14h2M12 14h2M16 14h0' },
  { type: 'TEXT', label: 'Textbox', icon: 'M5 5h14M12 5v15' },
  { type: 'SIGNER_NAME', label: 'Name', icon: 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0' },
  { type: 'FIRST_NAME', label: 'First Name', icon: 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0M17 4h4' },
  {
    type: 'COMPANY',
    label: 'Company',
    icon: 'M4 21V6a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v15M14 10h5a1 1 0 0 1 1 1v10M2 21h20M8 9h2M8 13h2',
  },
  { type: 'TITLE', label: 'Title', icon: 'M4 8h16v11H4zM9 8V5h6v3M4 13h16' },
  { type: 'CHECKBOX', label: 'Checkbox', icon: 'M5 5h14v14H5zM8.5 12l2.5 2.5 4.5-5' },
  { type: 'LAST_NAME', label: 'Last Name', icon: 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0M3 4h4' },
  { type: 'EMAIL', label: 'Email', icon: 'M3 6h18v12H3zM3 7l9 6 9-6' },
];

/** The self-sign tool row for this build (R-6 order). */
export function selfSignTools(
  available: readonly AuthoringFieldType[] = toolFieldTypes(),
): typeof SELF_SIGN_TOOLS {
  return SELF_SIGN_TOOLS.filter((x) => available.includes(x.type));
}
