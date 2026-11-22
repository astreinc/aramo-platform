// Client Rule Consolidation C3 (audit rows 30–31; Appendix A) — the recipient role labels
// and the witness rule, once for both Sign clients. The server refuses a witness without a
// signing recipient to attest for (witness_for_required / witness_for_invalid).
import type { RecipientKind } from './recipients.js';

/** Row 30 — the role labels (Appendix A). */
export const ROLE_LABELS: Readonly<Record<RecipientKind, string>> = {
  SIGNER: 'Signs',
  IN_PERSON_SIGNER: 'Signs in person',
  RECEIVES_COPY: 'Receives a copy',
  WITNESS: 'Witness',
};

/** A row read without a kind is a SIGNER (the column default). */
export function roleLabel(kind: RecipientKind | null | undefined): string {
  return ROLE_LABELS[kind ?? 'SIGNER'];
}

/** A recipient a witness can attest for: a SIGNER or an IN_PERSON_SIGNER. */
export function isWitnessable(kind: RecipientKind | null | undefined): boolean {
  const k = kind ?? 'SIGNER';
  return k === 'SIGNER' || k === 'IN_PERSON_SIGNER';
}

export interface WitnessRow {
  readonly key: string;
  readonly kind?: RecipientKind | null;
  /** WITNESS only: the key of the recipient it attests for. */
  readonly witnessFor?: string | null;
}

/** The recipients the witness `key` may attest for. */
export function witnessTargets<T extends WitnessRow>(list: readonly T[], key: string): T[] {
  return list.filter((r) => r.key !== key && isWitnessable(r.kind));
}

/**
 * Row 31 — a witness must point at a signer: the first witness in `list` whose target is
 * missing or not a signing recipient, or null when every witness is valid.
 */
export function danglingWitness<T extends WitnessRow>(list: readonly T[]): T | null {
  const ok = new Set(list.filter((r) => isWitnessable(r.kind)).map((r) => r.key));
  return list.find((r) => r.kind === 'WITNESS' && (r.witnessFor == null || r.witnessFor === r.key || !ok.has(r.witnessFor))) ?? null;
}

/** A second witness for the same signer (the server refuses it: witness_duplicate). */
export function duplicateWitness<T extends WitnessRow>(list: readonly T[]): T | null {
  const seen = new Set<string>();
  for (const r of list) {
    if (r.kind !== 'WITNESS' || r.witnessFor == null) continue;
    if (seen.has(r.witnessFor)) return r;
    seen.add(r.witnessFor);
  }
  return null;
}
