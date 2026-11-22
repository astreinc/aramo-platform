// Client Rule Consolidation C3 (audit rows 35–37; Appendix A) — which field types a sender
// places, their default size and whether a new field starts required. ONE table for both
// Sign clients; the server's authoring list (sender-envelope.service.ts FIELD_TYPES) is
// SENDER_FIELD_TYPES below.
// FIELD-PARITY-1 P1-0 / P1-1 — the lists and the default table are now projections of the one
// field catalog (@aramo/sign-fields, scope:shared, so the console's Form Studio reads the same
// table). This module keeps its public API unchanged.
import {
  FIELD_DEFAULTS as CATALOG_FIELD_DEFAULTS,
  fieldTypesFor,
  isFieldTypeOn,
  type FieldDefaults,
  type FieldTypeOn,
  type FieldTypeOnWhenAvailable,
} from '@aramo/sign-fields';

export type { FieldDefaults } from '@aramo/sign-fields';

/**
 * The types a sender authors on PUT …/fields (PX-V1 + M-A6 §2.1 + M-A12 W1-C.4). PAYMENT is
 * authorable separately, only while payments are available (Sign 1.14); ACKNOWLEDGEMENT is
 * engine-only (the S2S and Sign API paths) and is never placed by a sender.
 */
export const SENDER_FIELD_TYPES: readonly FieldTypeOn<'send_web'>[] = fieldTypesFor('send_web');
export type SenderFieldType = FieldTypeOn<'send_web'>;

/** Every field type a sender view may show (a stored field may be of any of them). */
export const ALL_FIELD_TYPES: readonly FieldTypeOn<'sign_store'>[] = fieldTypesFor('sign_store');
export type AnyFieldType = FieldTypeOn<'sign_store'>;

export function isSenderFieldType(v: unknown): v is SenderFieldType {
  return isFieldTypeOn('send_web', v);
}

/**
 * Row 35 — the types offered for placing: the server's list, plus PAYMENT only when the server
 * reports payments available (sender context features.payments) AND the client can author a
 * payment's amount.
 */
export function placeableFieldTypes(input: { readonly payments_available: boolean }): readonly FieldTypeOnWhenAvailable<'send_web'>[] {
  return fieldTypesFor('send_web', { payments_available: input.payments_available });
}

/**
 * Rows 36 / 37 — default sizes (mobile's, designed for touch placement; Appendix A) and
 * required-by-default: SIGNATURE, INITIALS, SIGN_DATE, SIGNER_NAME and the profile fields
 * start required; TEXT and CHECKBOX start optional. ACKNOWLEDGEMENT and PAYMENT (never placed
 * from the editors today) keep the web's sizes; a PAYMENT field is always required (server).
 * The values are the catalog's (FIELD-PARITY-1 P1-0), for the types a Sign envelope stores.
 */
export const FIELD_DEFAULTS: Readonly<Record<AnyFieldType, FieldDefaults>> = Object.fromEntries(
  ALL_FIELD_TYPES.map((t) => [t, CATALOG_FIELD_DEFAULTS[t]]),
) as Record<AnyFieldType, FieldDefaults>;

/** M-A12 W1-E.2 — the user's default field size (S / M / L) scales the placed size. */
export const FIELD_SIZE_SCALE = { S: 0.85, M: 1, L: 1.2 } as const;
export type FieldSizeKey = keyof typeof FIELD_SIZE_SCALE;

export function sizeScale(size: string | null | undefined): number {
  return size === 'S' || size === 'M' || size === 'L' ? FIELD_SIZE_SCALE[size] : 1;
}
