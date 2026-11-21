// Aramo-Sign-Unified-Product-Amendment-M-A5-Recipient-Kinds-Hosted-Self-Signing-v1_0-LOCKED
// §1.3 / §1.4 — the recipient kinds and the recipient limits.
// Client Rule Consolidation C2-4 — the pure values move here from libs/sign
// (domain/recipients.ts keeps the turn rules and re-exports these).
//
//   SIGNER            signs through an emailed link (and, when bound, self-signs).
//   IN_PERSON_SIGNER  signs on the host's device in a HOSTED session.
//   RECEIVES_COPY     never signs.
//   WITNESS           attests for ONE other signing recipient, after that signer signed.

export const RECIPIENT_KINDS = ['SIGNER', 'IN_PERSON_SIGNER', 'RECEIVES_COPY', 'WITNESS'] as const;
export type RecipientKind = (typeof RECIPIENT_KINDS)[number];

export const SIGNING_RECIPIENT_KINDS: readonly RecipientKind[] = ['SIGNER', 'IN_PERSON_SIGNER', 'WITNESS'];

export const COPY_DELIVERIES = ['ON_SEND', 'ON_COMPLETION', 'BOTH'] as const;
export type CopyDelivery = (typeof COPY_DELIVERIES)[number];

// M-A5 §1.4 — at most 10 signing recipients (MAX_SIGNERS, unchanged) and 10 copies.
export const MAX_COPY_RECIPIENTS = 10;
