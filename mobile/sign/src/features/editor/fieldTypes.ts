// The sender's field-authoring boundary. Directive §5, §7 C-13 set four tool types;
// M-A6 §2.1 (LOCKED) adds Name (SIGNER_NAME) and Checkbox (CHECKBOX), shown only when
// FEATURES.extraFieldTypes is on (M-A4 §2.2). ACKNOWLEDGEMENT stays engine-only:
// authoring never creates it and the server refuses it on PUT …/fields
// (`v1_field_type`). Signers still complete every engine type (§6).
// M-A12 W1-C.4 (LOCKED) adds the profile auto-fill types FIRST_NAME, LAST_NAME, EMAIL,
// COMPANY and TITLE (text-valued; the signer's own Sign profile pre-fills them at fill
// time and the signer may edit), shown while FEATURES.profileFieldTypes is on.
import {
  CHECKBOX_LABEL_MAX,
  FIELD_DEFAULTS,
  PROFILE_TEXT_FIELD_TYPES,
  isSenderFieldType,
  type ProfileTextFieldType,
  type SenderFieldType,
} from '@aramo/sign-client';

import { FEATURES } from '../../config/features';

export const BASE_FIELD_TYPES = ['SIGNATURE', 'INITIALS', 'SIGN_DATE', 'TEXT'] as const;
export const EXTRA_FIELD_TYPES = ['SIGNER_NAME', 'CHECKBOX'] as const;
// FIELD-PARITY-1 P1-2 — the catalog's profile prefill types (@aramo/sign-client over
// @aramo/sign-fields). The three tiers together are the catalog's `send_mobile` surface
// (held by __tests__/editorReducer.test.ts); this file only orders and gates the tools.
export const PROFILE_FIELD_TYPES: readonly ProfileTextFieldType[] = PROFILE_TEXT_FIELD_TYPES;
export const AUTHORING_FIELD_TYPES = [
  ...BASE_FIELD_TYPES,
  ...EXTRA_FIELD_TYPES,
  ...PROFILE_FIELD_TYPES,
] as const;

export type ProfileFieldType = ProfileTextFieldType;

const PROFILE_SET: ReadonlySet<string> = new Set(PROFILE_FIELD_TYPES);

/** M-A12 W1-C.4 — a text field the signer's Sign profile pre-fills. */
export function isProfileFieldType(v: unknown): v is ProfileFieldType {
  return typeof v === 'string' && PROFILE_SET.has(v);
}

// Client Rule Consolidation C3 (audit row 35) — the same set as the server's authoring list
// (@aramo/sign-client SENDER_FIELD_TYPES); this file only orders the tools.
export type AuthoringFieldType = SenderFieldType & (typeof AUTHORING_FIELD_TYPES)[number];

/** Every type the server accepts from a sender (a saved draft may hold any of them). */
export function isAuthoringFieldType(v: unknown): v is AuthoringFieldType {
  return isSenderFieldType(v);
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

export const MAX_LABEL = CHECKBOX_LABEL_MAX;

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

// C3 (audit rows 36–37) — the label and noun are this app's; the default size and whether a
// new field starts required come from @aramo/sign-client's ONE table (Appendix A).
const LOOK: Readonly<Record<AuthoringFieldType, Pick<FieldTypeSpec, 'label' | 'noun'>>> = {
  SIGNATURE: { label: 'Signature', noun: 'signature' },
  INITIALS: { label: 'Initials', noun: 'initials' },
  SIGN_DATE: { label: 'Date', noun: 'date' },
  TEXT: { label: 'Text', noun: 'text' },
  SIGNER_NAME: { label: 'Name', noun: 'name' },
  CHECKBOX: { label: 'Checkbox', noun: 'a checkbox' },
  FIRST_NAME: { label: 'First name', noun: 'first name' },
  LAST_NAME: { label: 'Last name', noun: 'last name' },
  EMAIL: { label: 'Email', noun: 'email' },
  COMPANY: { label: 'Company', noun: 'company' },
  TITLE: { label: 'Title', noun: 'title' },
};

export const FIELD_TYPE_SPECS: Readonly<Record<AuthoringFieldType, FieldTypeSpec>> = Object.fromEntries(
  AUTHORING_FIELD_TYPES.map((type) => [
    type,
    {
      ...LOOK[type],
      width: FIELD_DEFAULTS[type].width,
      height: FIELD_DEFAULTS[type].height,
      requiredByDefault: FIELD_DEFAULTS[type].required,
    },
  ]),
) as Record<AuthoringFieldType, FieldTypeSpec>;

/** M-A12 W1-E.2 — the user's default field size: the starting size of a placed field. */
export { FIELD_SIZE_SCALE, sizeScale, type FieldSizeKey } from '@aramo/sign-client';

/**
 * M-A14 R-6 — the Sign Document tool row: one horizontally scrolling row of circles in the
 * prototype's order (Signature, Initials, Date, Textbox, Name, First Name, Company, Title,
 * Checkbox), then Last Name and Email, which the backend supports (D-5). Replaces "More
 * fields" in self-sign only; the Send flow editor is unchanged. Types this build does not
 * author (FEATURES) are left out.
 */
// M-A19-A1 (PO 2026-11-21) — DocuSign order: signing marks, then who-you-are fields, then
// free input: Signature, Initials, Date, Name, First Name, Last Name, Email, Company, Title,
// Textbox, Checkbox. Replaces M-A14 R-6's prototype order.
export const SELF_SIGN_TOOLS: readonly {
  readonly type: AuthoringFieldType;
  readonly label: string;
  /** 24-unit stroke path. */
  readonly icon: string;
}[] = [
  { type: 'SIGNATURE', label: 'Signature', icon: 'M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16zM14 6l4 4M3 22h18' },
  { type: 'INITIALS', label: 'Initials', icon: 'M3 17 7 6l4 11M4.5 13h5M14 6h7l-7 11h7M3 21h18' },
  { type: 'SIGN_DATE', label: 'Date', icon: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4M8 14h2M12 14h2M16 14h0' },
  { type: 'SIGNER_NAME', label: 'Name', icon: 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0' },
  { type: 'FIRST_NAME', label: 'First Name', icon: 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0M17 4h4' },
  { type: 'LAST_NAME', label: 'Last Name', icon: 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0M3 4h4' },
  { type: 'EMAIL', label: 'Email', icon: 'M3 6h18v12H3zM3 7l9 6 9-6' },
  {
    type: 'COMPANY',
    label: 'Company',
    icon: 'M4 21V6a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v15M14 10h5a1 1 0 0 1 1 1v10M2 21h20M8 9h2M8 13h2',
  },
  { type: 'TITLE', label: 'Title', icon: 'M4 8h16v11H4zM9 8V5h6v3M4 13h16' },
  { type: 'TEXT', label: 'Textbox', icon: 'M5 5h14M12 5v15' },
  { type: 'CHECKBOX', label: 'Checkbox', icon: 'M5 5h14v14H5zM8.5 12l2.5 2.5 4.5-5' },
];

/** The tool row for this build — M-A19-A1 DocuSign order (Sign a document and the Send flow). */
export function selfSignTools(
  available: readonly AuthoringFieldType[] = toolFieldTypes(),
): typeof SELF_SIGN_TOOLS {
  return SELF_SIGN_TOOLS.filter((x) => available.includes(x.type));
}
