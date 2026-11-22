// Client Rule Consolidation C3 (audit rows 35–37; Appendix A) — which field types a sender
// places, their default size and whether a new field starts required. ONE table for both
// Sign clients; the server's authoring list (sender-envelope.service.ts FIELD_TYPES) is
// SENDER_FIELD_TYPES below.
import { PAYMENT_FIELD_TYPE, PROFILE_TEXT_FIELD_TYPES } from './field-rules.js';

/**
 * The types a sender authors on PUT …/fields (PX-V1 + M-A6 §2.1 + M-A12 W1-C.4). PAYMENT is
 * authorable separately, only while payments are available (Sign 1.14); ACKNOWLEDGEMENT is
 * engine-only (the S2S and Sign API paths) and is never placed by a sender.
 */
export const SENDER_FIELD_TYPES = ['SIGNATURE', 'SIGN_DATE', 'INITIALS', 'TEXT', 'SIGNER_NAME', 'CHECKBOX', ...PROFILE_TEXT_FIELD_TYPES] as const;
export type SenderFieldType = (typeof SENDER_FIELD_TYPES)[number];

/** Every field type a sender view may show (a stored field may be of any of them). */
export const ALL_FIELD_TYPES = [...SENDER_FIELD_TYPES, 'ACKNOWLEDGEMENT', PAYMENT_FIELD_TYPE] as const;
export type AnyFieldType = (typeof ALL_FIELD_TYPES)[number];

const SENDER_SET: ReadonlySet<string> = new Set(SENDER_FIELD_TYPES);

export function isSenderFieldType(v: unknown): v is SenderFieldType {
  return typeof v === 'string' && SENDER_SET.has(v);
}

/**
 * Row 35 — the types offered for placing: the server's list, plus PAYMENT only when the server
 * reports payments available (sender context features.payments) AND the client can author a
 * payment's amount.
 */
export function placeableFieldTypes(input: { readonly payments_available: boolean }): readonly AnyFieldType[] {
  return input.payments_available ? [...SENDER_FIELD_TYPES, PAYMENT_FIELD_TYPE] : [...SENDER_FIELD_TYPES];
}

export interface FieldDefaults {
  /** Default size in PDF points. */
  readonly width: number;
  readonly height: number;
  /** Whether a newly placed field starts required (the sender may change it). */
  readonly required: boolean;
}

/**
 * Rows 36 / 37 — default sizes (mobile's, designed for touch placement; Appendix A) and
 * required-by-default: SIGNATURE, INITIALS, SIGN_DATE, SIGNER_NAME and the profile fields
 * start required; TEXT and CHECKBOX start optional. ACKNOWLEDGEMENT and PAYMENT (never placed
 * from the editors today) keep the web's sizes; a PAYMENT field is always required (server).
 */
export const FIELD_DEFAULTS: Readonly<Record<AnyFieldType, FieldDefaults>> = {
  SIGNATURE: { width: 230, height: 50, required: true },
  INITIALS: { width: 60, height: 30, required: true },
  SIGN_DATE: { width: 150, height: 22, required: true },
  TEXT: { width: 230, height: 22, required: false },
  SIGNER_NAME: { width: 200, height: 22, required: true },
  CHECKBOX: { width: 18, height: 18, required: false },
  FIRST_NAME: { width: 150, height: 22, required: true },
  LAST_NAME: { width: 150, height: 22, required: true },
  EMAIL: { width: 200, height: 22, required: true },
  COMPANY: { width: 200, height: 22, required: true },
  TITLE: { width: 200, height: 22, required: true },
  ACKNOWLEDGEMENT: { width: 400, height: 26, required: true },
  PAYMENT: { width: 160, height: 26, required: true },
};

/** M-A12 W1-E.2 — the user's default field size (S / M / L) scales the placed size. */
export const FIELD_SIZE_SCALE = { S: 0.85, M: 1, L: 1.2 } as const;
export type FieldSizeKey = keyof typeof FIELD_SIZE_SCALE;

export function sizeScale(size: string | null | undefined): number {
  return size === 'S' || size === 'M' || size === 'L' ? FIELD_SIZE_SCALE[size] : 1;
}
