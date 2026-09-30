// Enterprise Search GS-2 — Talent embedding lifecycle vocabulary + transitions (pure; mirrors the
// CI run state-machine idiom). Three states per the directive: pending → ready | failed, with
// re-drive edges. Consent revocation is NOT a state — it is an INVALIDATION action (the row is
// removed), so a revoked Talent never lingers as a stale "ready" vector. This lives in the
// talent-embedding lib (owns the Prisma enum of the same name) so the worker (apps/api) and the
// repository (this lib) share one source of truth.
//
//   pending — needs (re)embedding: newly enqueued, source changed, model-version bumped, rebuild,
//             or a consent-change re-check requested.
//   ready   — a current vector is persisted (source_hash + embedding_model match the live source).
//   failed  — the last attempt errored (retryable); a retry trigger re-drives it to pending.

export const TALENT_EMBEDDING_STATUSES = ['pending', 'ready', 'failed'] as const;
export type TalentEmbeddingStatus = (typeof TALENT_EMBEDDING_STATUSES)[number];

export const TALENT_EMBEDDING_TRANSITIONS: Readonly<
  Record<TalentEmbeddingStatus, readonly TalentEmbeddingStatus[]>
> = {
  pending: ['ready', 'failed'],
  ready: ['pending'],
  failed: ['pending'],
} as const;

export function canTalentEmbeddingTransition(
  from: TalentEmbeddingStatus,
  to: TalentEmbeddingStatus,
): boolean {
  return TALENT_EMBEDDING_TRANSITIONS[from].includes(to);
}
