// The sender's field-authoring boundary. Directive §5, §7 C-13 set four tool types;
// M-A6 §2.1 (LOCKED) adds Name (SIGNER_NAME) and Checkbox (CHECKBOX), shown only when
// FEATURES.extraFieldTypes is on (M-A4 §2.2). ACKNOWLEDGEMENT stays engine-only:
// authoring never creates it and the server refuses it on PUT …/fields
// (`v1_field_type`). Signers still complete every engine type (§6).
import { FEATURES } from '../../config/features';

export const BASE_FIELD_TYPES = ['SIGNATURE', 'INITIALS', 'SIGN_DATE', 'TEXT'] as const;
export const EXTRA_FIELD_TYPES = ['SIGNER_NAME', 'CHECKBOX'] as const;
export const AUTHORING_FIELD_TYPES = [...BASE_FIELD_TYPES, ...EXTRA_FIELD_TYPES] as const;

export type AuthoringFieldType = (typeof AUTHORING_FIELD_TYPES)[number];

const AUTHORING_SET: ReadonlySet<string> = new Set(AUTHORING_FIELD_TYPES);

/** Every type the server accepts from a sender (a saved draft may hold any of them). */
export function isAuthoringFieldType(v: unknown): v is AuthoringFieldType {
  return typeof v === 'string' && AUTHORING_SET.has(v);
}

/** The tools the editor offers in this build. */
export function toolFieldTypes(
  extra: boolean = FEATURES.extraFieldTypes,
): readonly AuthoringFieldType[] {
  return extra ? AUTHORING_FIELD_TYPES : BASE_FIELD_TYPES;
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
};
