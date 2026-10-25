// The sender's field-authoring boundary (directive §5, §7 C-13): exactly four tool
// types. The prototype's Name and Checkbox tools are removed. Signers still complete
// every engine type (§6), but authoring never creates the others, and the server
// refuses them on PUT …/fields (`v1_field_type`).

export const AUTHORING_FIELD_TYPES = ['SIGNATURE', 'INITIALS', 'SIGN_DATE', 'TEXT'] as const;

export type AuthoringFieldType = (typeof AUTHORING_FIELD_TYPES)[number];

const AUTHORING_SET: ReadonlySet<string> = new Set(AUTHORING_FIELD_TYPES);

export function isAuthoringFieldType(v: unknown): v is AuthoringFieldType {
  return typeof v === 'string' && AUTHORING_SET.has(v);
}

export interface FieldTypeSpec {
  /** Tool and panel label. */
  readonly label: string;
  /** Lower-case form for the hint "Tap the page to place {type} for {name}". */
  readonly noun: string;
  /** Default size in PDF points (handoff §4.6). */
  readonly width: number;
  readonly height: number;
  /** Every type except Text starts as required (handoff §4.6). */
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
};
