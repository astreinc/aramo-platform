import type { TalentWorkAuthorizationRow } from './talent-evidence.repository.js';

// TALENT-INTEL-1 TI-1G §2 — the DETERMINISTIC current-work-authorization selection
// over the append-only assertion history. NOT "latest DB row wins": an assertion is
// eligible to be the CURRENT state only if it is not future-dated and not expired at
// `now`; among the eligible assertions the most-recently-ASSERTED wins (a newer
// assertion supersedes an older one), with a fully deterministic tiebreak. No LLM,
// no inference, no invented dates — assertions with NULL temporal bounds are always
// time-eligible (the recruiter simply did not state a window).
//
// Eligibility at `now`:
//   effective_from == null OR effective_from <= now   (not future-dated)
//   effective_to   == null OR effective_to   >= now   (window not ended)
//   expires_at     == null OR expires_at     >= now    (not expired)
// Winner: max asserted_at → tiebreak max updated_at → tiebreak max id (stable string).
export function selectCurrentWorkAuthorization(
  rows: readonly TalentWorkAuthorizationRow[],
  now: Date,
): TalentWorkAuthorizationRow | null {
  const t = now.getTime();
  const eligible = rows.filter((r) => {
    if (r.effective_from !== null && r.effective_from.getTime() > t) return false;
    if (r.effective_to !== null && r.effective_to.getTime() < t) return false;
    if (r.expires_at !== null && r.expires_at.getTime() < t) return false;
    return true;
  });
  if (eligible.length === 0) return null;
  return eligible.reduce((best, r) => {
    const a = r.asserted_at.getTime();
    const b = best.asserted_at.getTime();
    if (a !== b) return a > b ? r : best;
    const au = r.updated_at.getTime();
    const bu = best.updated_at.getTime();
    if (au !== bu) return au > bu ? r : best;
    return r.id > best.id ? r : best;
  });
}
