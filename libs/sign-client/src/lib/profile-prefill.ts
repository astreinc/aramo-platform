// Field-test batch 1 §2 SIG-11, as amended by A1 — profile values on the signing page. ONE copy
// for the server (which decides who gets them), the sign-web signing page and the Aramo Sign app.
//
//   profilePrefill   the values by field type, from the signer's own Sign profile and the
//                    recipient email the sender typed (SIG-2):
//                      FIRST_NAME  the first word of display_name
//                      LAST_NAME   the rest of display_name (a single word: none; the first
//                                  name is never copied into the last name)
//                      EMAIL       the RECIPIENT email (sender-held, D-5)
//                      COMPANY     company
//                      TITLE       title
//                    The signer-name field is never filled (M-A6, D-3). Empty values are omitted.
//   Two kinds (A1-2): EMAIL is sender-held and is pre-filled when the document opens; the
//                    others are OFFERS — never placed in a field until the signer takes them
//                    (the "Fill from my profile" banner, or one field's hint). An offer the
//                    signer did not take is never sent (A1-4).
//   Guards (A1-3):   read-only, sender-filled, server-filled and hidden fields are never
//                    filled or offered (callers pass only the SHOWN fields), nor one that
//                    already holds a value.
//
// Pure TypeScript ESM (type:client-shared).
import { PROFILE_TEXT_FIELD_TYPES, type ProfileTextFieldType } from '@aramo/sign-fields';

import { isServerFilledName, isSignerLocked } from './field-rules.js';

/** What the rule reads from the signer's Sign profile. */
export interface ProfilePrefillSource {
  readonly display_name?: string | null;
  readonly company?: string | null;
  readonly title?: string | null;
}

/** The values by field type (the document view's `profile_prefill`). */
export type ProfilePrefill = Partial<Record<ProfileTextFieldType, string>>;

const PROFILE_TYPES: ReadonlySet<string> = new Set(PROFILE_TEXT_FIELD_TYPES);

/** A1-2 — the value the sender already holds (pre-filled on open, never an offer). */
export const SENDER_HELD_PREFILL_TYPES: ReadonlySet<string> = new Set<ProfileTextFieldType>(['EMAIL']);

/** A1-6 — the one wording for the banner, the per-field hint and the notice after a fill. */
export const PROFILE_OFFER_COPY = {
  banner: 'Fill from my profile',
  hint: (value: string): string => `Use from my profile: ${value}`,
  filled: (n: number): string => `Filled ${n} fields from your profile. Check them before you finish.`,
} as const;

const clean = (x: string | null | undefined): string | null => (typeof x === 'string' && x.trim().length > 0 ? x.trim() : null);

/** SIG-2 — the values by field type; empty values are left out. */
export function profilePrefill(profile: ProfilePrefillSource | null | undefined, recipientEmail: string | null | undefined): ProfilePrefill {
  const [first, ...rest] = (profile?.display_name ?? '').trim().split(/\s+/).filter(Boolean);
  const entries: Array<[ProfileTextFieldType, string | null]> = [
    ['FIRST_NAME', clean(first)],
    ['LAST_NAME', clean(rest.join(' '))],
    ['EMAIL', clean(recipientEmail)],
    ['COMPANY', clean(profile?.company)],
    ['TITLE', clean(profile?.title)],
  ];
  const out: ProfilePrefill = {};
  for (const [type, value] of entries) if (value !== null) out[type] = value;
  return out;
}

/** The field facts the guards read. */
export interface PrefillFieldLike {
  readonly field_type: string;
  readonly name_mode?: string | null;
  readonly server_filled?: boolean | null;
  readonly sender_filled?: boolean | null;
  readonly read_only?: boolean | null;
}

/** A profile field the signer fills (never read-only, sender-filled or server-filled). */
export function isPrefillTarget(f: PrefillFieldLike): boolean {
  return PROFILE_TYPES.has(f.field_type) && f.server_filled !== true && !isServerFilledName(f) && !isSignerLocked(f);
}

function valueFor(f: PrefillFieldLike, prefill: ProfilePrefill | null | undefined): string | null {
  if (prefill === null || prefill === undefined || !isPrefillTarget(f)) return null;
  return clean((prefill as Record<string, string | undefined>)[f.field_type]);
}

/** One profile field's offer (not a sender-held value), or null: none, not empty, or guarded. */
export function profileOfferFor(f: PrefillFieldLike, prefill: ProfilePrefill | null | undefined, hasValue: boolean): string | null {
  if (hasValue || SENDER_HELD_PREFILL_TYPES.has(f.field_type)) return null;
  return valueFor(f, prefill);
}

export interface PrefillMatch<T> {
  readonly field: T;
  readonly value: string;
}

/**
 * A1-3 — the offers the banner fills in one tap: every empty, signer-editable profile field of
 * `shown` (the fields shown for the signer's answers) that has an offer. Empty list: no banner.
 */
export function profileOffers<T extends PrefillFieldLike>(shown: readonly T[], prefill: ProfilePrefill | null | undefined, hasValue: (f: T) => boolean): PrefillMatch<T>[] {
  const out: PrefillMatch<T>[] = [];
  for (const f of shown) {
    const value = profileOfferFor(f, prefill, hasValue(f));
    if (value !== null) out.push({ field: f, value });
  }
  return out;
}

/** A1-2 — the sender-held values pre-filled when the document opens (empty, editable, shown). */
export function senderHeldPrefills<T extends PrefillFieldLike>(shown: readonly T[], prefill: ProfilePrefill | null | undefined, hasValue: (f: T) => boolean): PrefillMatch<T>[] {
  const out: PrefillMatch<T>[] = [];
  for (const f of shown) {
    if (hasValue(f) || !SENDER_HELD_PREFILL_TYPES.has(f.field_type)) continue;
    const value = valueFor(f, prefill);
    if (value !== null) out.push({ field: f, value });
  }
  return out;
}
