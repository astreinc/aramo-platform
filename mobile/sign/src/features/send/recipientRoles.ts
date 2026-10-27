// Recipient kinds in the Send flow (M-A5 §1, §2, §3.5, §4.1; M-A4 §6.1). Plain rules
// that mirror what PUT …/recipients refuses, so the sender learns it before a save
// fails — the server still decides, and its reason is shown when it refuses:
//   - signing recipients (SIGNER, IN_PERSON_SIGNER): at most 10 (too_many_signers);
//   - RECEIVES_COPY: at most 10 (too_many_copy_recipients), with a copy timing
//     (copy_delivery_required), and never any fields (copy_recipient_has_fields);
//   - emails are distinct across all kinds; a missing email is never a duplicate;
//   - email is optional for IN_PERSON_SIGNER only;
//   - Assign to me applies to SIGNER only (assign_to_me_not_signer).
// Copy recipients never take part in the signing order: the wire list is the signing
// recipients in their order, then the copy recipients.
import {
  MAX_COPY_RECIPIENTS,
  MAX_RECIPIENTS,
  type CopyDelivery,
  type DraftRecipient,
  type RecipientKind,
} from './draftModel';

export const ROLE_CHIPS: readonly { readonly kind: RecipientKind; readonly label: string }[] = [
  { kind: 'SIGNER', label: 'Signs' },
  { kind: 'IN_PERSON_SIGNER', label: 'In person' },
  { kind: 'RECEIVES_COPY', label: 'Copy' },
];

export const COPY_TIMING: readonly { readonly key: CopyDelivery; readonly label: string }[] = [
  { key: 'ON_SEND', label: 'When sent' },
  { key: 'ON_COMPLETION', label: 'After completion' },
  { key: 'BOTH', label: 'Both' },
];

/** A new copy recipient receives the completed document (handoff §4.6 footnote). */
export const DEFAULT_COPY_DELIVERY: CopyDelivery = 'ON_COMPLETION';

export function copyTimingLabel(d: CopyDelivery | null | undefined): string {
  return COPY_TIMING.find((x) => x.key === d)?.label ?? 'Not chosen';
}

type Kinded = Pick<DraftRecipient, 'kind'>;

export function kindOf(r: Kinded): RecipientKind {
  return r.kind ?? 'SIGNER';
}
export function isCopy(r: Kinded): boolean {
  return kindOf(r) === 'RECEIVES_COPY';
}
export function isInPerson(r: Kinded): boolean {
  return kindOf(r) === 'IN_PERSON_SIGNER';
}
export function signingRecipients<T extends Kinded>(list: readonly T[]): T[] {
  return list.filter((r) => !isCopy(r));
}
export function copyRecipients<T extends Kinded>(list: readonly T[]): T[] {
  return list.filter(isCopy);
}

/** The lower-cased email, or null when there is none (an in-person signer). */
export function emailKey(email: string): string | null {
  const e = email.trim().toLowerCase();
  return e.length > 0 ? e : null;
}

/** True when another recipient already has this email (a missing email never duplicates). */
export function isDuplicateEmail(
  list: readonly Pick<DraftRecipient, 'key' | 'email'>[],
  email: string,
  exceptKey?: string,
): boolean {
  const k = emailKey(email);
  if (k === null) return false;
  return list.some((r) => r.key !== exceptKey && emailKey(r.email) === k);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function validEmail(email: string): boolean {
  const e = email.trim();
  return e.length <= 254 && EMAIL_RE.test(e);
}

export type AddCheck = 'ok' | 'duplicate' | 'signers_full' | 'copies_full' | 'email_required';

/** Whether a recipient of `kind` with `email` can be added. */
export function checkAdd(
  list: readonly DraftRecipient[],
  kind: RecipientKind,
  email: string,
): AddCheck {
  if (kind === 'RECEIVES_COPY') {
    if (copyRecipients(list).length >= MAX_COPY_RECIPIENTS) return 'copies_full';
  } else if (signingRecipients(list).length >= MAX_RECIPIENTS) return 'signers_full';
  if (kind !== 'IN_PERSON_SIGNER' && emailKey(email) === null) return 'email_required';
  if (isDuplicateEmail(list, email)) return 'duplicate';
  return 'ok';
}

export type KindChange =
  | { readonly ok: true; readonly recipients: DraftRecipient[]; readonly dropsFields: boolean }
  | { readonly ok: false; readonly reason: 'signers_full' | 'copies_full' | 'email_required' };

/**
 * Change a recipient's kind. Moving to Copy drops their fields (a copy recipient has
 * none) and picks the default timing; leaving Copy clears the timing. Assign to me is
 * kept locally but only sent while the recipient is a SIGNER (recipientsToWire).
 */
export function changeKind(
  list: readonly DraftRecipient[],
  key: string,
  kind: RecipientKind,
): KindChange {
  const r = list.find((x) => x.key === key);
  if (!r || kindOf(r) === kind) return { ok: true, recipients: [...list], dropsFields: false };
  const others = list.filter((x) => x.key !== key);
  if (kind === 'RECEIVES_COPY') {
    if (copyRecipients(others).length >= MAX_COPY_RECIPIENTS)
      return { ok: false, reason: 'copies_full' };
  } else if (isCopy(r) && signingRecipients(others).length >= MAX_RECIPIENTS) {
    return { ok: false, reason: 'signers_full' };
  }
  if (kind !== 'IN_PERSON_SIGNER' && emailKey(r.email) === null)
    return { ok: false, reason: 'email_required' };
  const next: DraftRecipient = {
    ...r,
    kind,
    copyDelivery: kind === 'RECEIVES_COPY' ? (r.copyDelivery ?? DEFAULT_COPY_DELIVERY) : null,
  };
  return {
    ok: true,
    recipients: list.map((x) => (x.key === key ? next : x)),
    dropsFields: kind === 'RECEIVES_COPY',
  };
}

/** Signing recipients in their order, then copy recipients (never part of the order). */
export function wireOrder<T extends Kinded>(list: readonly T[]): T[] {
  return [...signingRecipients(list), ...copyRecipients(list)];
}

export interface RecipientWire {
  readonly id?: string;
  readonly name: string;
  readonly email: string | null;
  readonly recipient_kind: RecipientKind;
  readonly copy_delivery?: CopyDelivery;
  readonly assign_to_me?: true;
}

/** The PUT …/recipients items, in wire order. */
export function recipientsToWire(list: readonly DraftRecipient[]): RecipientWire[] {
  return wireOrder(list).map((r) => {
    const kind = kindOf(r);
    const email = emailKey(r.email) === null ? null : r.email.trim();
    return {
      ...(r.serverId ? { id: r.serverId } : {}),
      name: r.name,
      email,
      recipient_kind: kind,
      ...(kind === 'RECEIVES_COPY'
        ? { copy_delivery: r.copyDelivery ?? DEFAULT_COPY_DELIVERY }
        : {}),
      ...(kind === 'SIGNER' && r.assignToMe === true ? { assign_to_me: true as const } : {}),
    };
  });
}

/** Sender-facing copy for the role rules (client checks and the server's reasons). */
export const ROLE_COPY = {
  duplicate: 'This person is already on the envelope.',
  signers_full: `An envelope can have up to ${MAX_RECIPIENTS} signers.`,
  copies_full: `An envelope can have up to ${MAX_COPY_RECIPIENTS} people who receive a copy.`,
  email_required: 'Add an email address for this person, or choose In person.',
  copy_delivery_required: 'Choose when each copy recipient receives their copy.',
  copy_recipient_has_fields: 'People who receive a copy can’t have fields.',
  assign_to_me_not_signer: 'Only a signer can be assigned to you.',
  assign_to_me_email_mismatch:
    'You can assign a recipient to yourself only with your own verified account email.',
} as const;
