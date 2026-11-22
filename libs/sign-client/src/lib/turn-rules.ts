// M-A5 §1.3 / Multi-Signer §4 / Feature-Parity §1.17 — who the signing recipients are and
// whose turn it is. Pure. Client Rule Consolidation C3 (PO 2026-11-21, D-1) — moved here from
// libs/sign/src/lib/domain/recipients.ts (which re-exports them) so the locked-check rules in
// locked-rules.ts, the server's in-lock checks and the C1 `actions` predicates share one copy.
import type { RecipientKind } from './recipients.js';

export interface KindRow {
  recipient_kind?: string | null;
}
export interface TurnRow extends KindRow {
  id: string;
  status: string;
  signing_order: number;
  // §1.17 — set for a WITNESS only (rows read without it are never witnesses).
  witness_for_signer_id?: string | null;
}

// A row without recipient_kind (an older read) is a SIGNER: the column default.
export function recipientKindOf(r: KindRow): RecipientKind {
  const k = r.recipient_kind;
  return k === 'IN_PERSON_SIGNER' || k === 'RECEIVES_COPY' || k === 'WITNESS' ? k : 'SIGNER';
}

export function isWitness(r: KindRow): boolean {
  return recipientKindOf(r) === 'WITNESS';
}

// §1.17 — a witness may act only once the signer it witnesses has SIGNED. Every
// other recipient is always "ready" by this rule (turn rules still apply).
export function witnessReady(rows: readonly { id: string; status: string }[], r: KindRow & { witness_for_signer_id?: string | null }): boolean {
  if (!isWitness(r)) return true;
  const principal = rows.find((x) => x.id === r.witness_for_signer_id);
  return principal !== undefined && principal.status === 'SIGNED';
}

export function isSigningRecipient(r: KindRow): boolean {
  return recipientKindOf(r) !== 'RECEIVES_COPY';
}

export function isCopyRecipient(r: KindRow): boolean {
  return recipientKindOf(r) === 'RECEIVES_COPY';
}

// Only a SIGNER (and, §1.17, a WITNESS) is emailed a signing link (invitation and reminder).
export function isLinkSigner(r: KindRow): boolean {
  const k = recipientKindOf(r);
  return k === 'SIGNER' || k === 'WITNESS';
}

export function signingRecipients<T extends KindRow>(rows: readonly T[]): T[] {
  return rows.filter(isSigningRecipient);
}

export function copyRecipients<T extends KindRow & { copy_delivery?: string | null }>(rows: readonly T[], when: 'SEND' | 'COMPLETION'): T[] {
  const wanted = when === 'SEND' ? ['ON_SEND', 'BOTH'] : ['ON_COMPLETION', 'BOTH'];
  return rows.filter((r) => isCopyRecipient(r) && wanted.includes(r.copy_delivery ?? ''));
}

// Every signing recipient has signed (the envelope completes). Copies never block.
export function allSigningRecipientsSigned(rows: readonly (KindRow & { status: string })[]): boolean {
  const signing = signingRecipients(rows);
  return signing.length > 0 && signing.every((s) => s.status === 'SIGNED');
}

// Multi-Signer §4 — in a SEQUENTIAL envelope the recipient whose turn it is: the
// lowest signing_order among signing recipients who have not SIGNED (null when
// every one has). Copies never take a turn.
export function currentTurnOf<T extends TurnRow>(rows: readonly T[]): T | null {
  const open = signingRecipients(rows)
    .filter((s) => s.status !== 'SIGNED')
    .sort((a, b) => a.signing_order - b.signing_order);
  return open[0] ?? null;
}


// Whether `signer_id` may act now: PARALLEL — any signing recipient; SEQUENTIAL —
// only the one whose turn it is.
export function mayActNow<T extends TurnRow>(routing_mode: string, rows: readonly T[], signer_id: string): boolean {
  const row = rows.find((r) => r.id === signer_id);
  if (row === undefined || !isSigningRecipient(row)) return false;
  if (!witnessReady(rows, row)) return false;
  if (routing_mode !== 'SEQUENTIAL') return true;
  return currentTurnOf(rows)?.id === signer_id;
}

