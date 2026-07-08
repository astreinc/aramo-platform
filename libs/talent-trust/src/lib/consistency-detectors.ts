import { sameUltimateSource } from './band-derivation.js';
import type { EvidenceStatus, SourceClass } from './vocab.js';

// TR-4 B3 (DDR §4) — the deterministic consistency detectors, PURE. Given a
// subject's cluster-union CLAIMS evidence (+ its existing TIMELINE_GAP records),
// compute the action plan: which records are contradicted-by-arithmetic, which
// independent-source pairs disagree over the same window, which interior gaps to
// open, and which recorded gaps have healed. NO I/O — the service executes the plan.
//
// Silence over speculation (propose-never-dispose): a null date, a missing
// employer_norm, a non-independent pair, or a non-interior hole yields NOTHING.
// R10: reasons + day thresholds only — never ordinal language, never a numeric
// signal on any surface.

export const REASON_IMPOSSIBLE_RANGE = 'IMPOSSIBLE_RANGE';
export const REASON_EMPLOYER_CONFLICT_SAME_WINDOW = 'EMPLOYER_CONFLICT_SAME_WINDOW';

// Engine constants (§3.2).
export const OVERLAP_THRESHOLD_DAYS = 30;
export const GAP_THRESHOLD_DAYS = 180;

export interface EmploymentClaim {
  evidence_id: string;
  source_class: SourceClass;
  source_ref: unknown | null;
  employer_norm: string | null;
  start_date: string | null; // ISO calendar date or null
  end_date: string | null;
  collected_at: Date;
  current_status: EvidenceStatus;
}

export interface ExistingGap {
  evidence_id: string;
  before_evidence_id: string;
  after_evidence_id: string;
  gap_start: string;
  gap_end: string;
  current_status: EvidenceStatus;
}

export interface OpenGap {
  gap_start: string;
  gap_end: string;
  before_evidence_id: string;
  after_evidence_id: string;
}

export interface ConsistencyPlan {
  // → contradictRecord(id, IMPOSSIBLE_RANGE) — linkless single-record flip.
  impossibleRangeIds: string[];
  // → contradict(a, b, EMPLOYER_CONFLICT_SAME_WINDOW) — pairwise link + status.
  employerConflicts: Array<{ a_id: string; b_id: string }>;
  // → recordTimelineGapIfAbsent(...) — CONTINUITY gap signal (idempotent).
  gapsToOpen: OpenGap[];
  // → supersede(gapEvidenceId, fillerId) — a healed gap stops haunting the record.
  gapsToHeal: Array<{ gap_evidence_id: string; filler_evidence_id: string }>;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Parse an ISO calendar date to epoch-day integer (UTC). Deterministic.
function epochDay(iso: string): number {
  return Math.floor(Date.parse(`${iso}T00:00:00.000Z`) / MS_PER_DAY);
}

function isFullyDated(c: EmploymentClaim): boolean {
  return c.start_date !== null && c.end_date !== null;
}

// Detector 1 — impossible range (end < start, both non-null). Already-CONTRADICTED
// records are skipped (the service also guards). Null dates → silent.
function detectImpossibleRanges(claims: EmploymentClaim[]): string[] {
  const out: string[] = [];
  for (const c of claims) {
    if (c.current_status === 'CONTRADICTED') continue;
    if (c.start_date === null || c.end_date === null) continue;
    if (epochDay(c.end_date) < epochDay(c.start_date)) out.push(c.evidence_id);
  }
  return out;
}

// Detector 2 — same-window employer disagreement. Independent sources only
// (SELF collapses), both windows fully dated, overlap ≥ OVERLAP_THRESHOLD_DAYS,
// employer_norm present on both AND unequal. Unordered pairs, de-duplicated.
function detectEmployerConflicts(
  claims: EmploymentClaim[],
): Array<{ a_id: string; b_id: string }> {
  const dated = claims.filter(
    (c) => c.current_status === 'VALID' && isFullyDated(c) && (c.employer_norm ?? '') !== '',
  );
  const out: Array<{ a_id: string; b_id: string }> = [];
  for (let i = 0; i < dated.length; i++) {
    for (let j = i + 1; j < dated.length; j++) {
      const a = dated[i]!;
      const b = dated[j]!;
      if (a.employer_norm === b.employer_norm) continue; // agree → silent
      if (sameUltimateSource(a, b)) continue; // not independent → silent
      const overlap =
        Math.min(epochDay(a.end_date!), epochDay(b.end_date!)) -
        Math.max(epochDay(a.start_date!), epochDay(b.start_date!));
      if (overlap >= OVERLAP_THRESHOLD_DAYS) {
        // Deterministic ordering (by evidence_id) so the pair is stable across runs.
        const [x, y] = a.evidence_id < b.evidence_id ? [a, b] : [b, a];
        out.push({ a_id: x.evidence_id, b_id: y.evidence_id });
      }
    }
  }
  return out;
}

// Detector 3 — interior timeline gaps. Sort fully-dated VALID employment by start;
// walk, tracking the running max end (so overlapping/nested jobs never create a
// false gap). A hole > GAP_THRESHOLD_DAYS between the running coverage end and the
// next start is an INTERIOR gap (never before the first job or after the last).
function computeCurrentGaps(claims: EmploymentClaim[]): OpenGap[] {
  const windows = claims
    .filter((c) => c.current_status === 'VALID' && isFullyDated(c))
    .map((c) => ({
      id: c.evidence_id,
      start: epochDay(c.start_date!),
      end: epochDay(c.end_date!),
      start_iso: c.start_date!,
      end_iso: c.end_date!,
    }))
    .sort((p, q) => (p.start !== q.start ? p.start - q.start : p.id < q.id ? -1 : 1));

  const gaps: OpenGap[] = [];
  if (windows.length < 2) return gaps;
  let coverEnd = windows[0]!.end;
  let coverEndId = windows[0]!.id;
  let coverEndIso = windows[0]!.end_iso;
  for (let i = 1; i < windows.length; i++) {
    const w = windows[i]!;
    if (w.start - coverEnd > GAP_THRESHOLD_DAYS) {
      gaps.push({
        gap_start: coverEndIso,
        gap_end: w.start_iso,
        before_evidence_id: coverEndId,
        after_evidence_id: w.id,
      });
    }
    if (w.end > coverEnd) {
      coverEnd = w.end;
      coverEndId = w.id;
      coverEndIso = w.end_iso;
    }
  }
  return gaps;
}

// A recorded gap has HEALED when it is no longer a current gap. The filler is the
// employment claim whose window now covers (intersects) the old gap interval —
// deterministic pick: earliest-collected, then smallest id. If no filler covers it
// (the gap vanished for another reason), it is left for the next run.
function detectHealedGaps(
  currentGaps: OpenGap[],
  existingGaps: ExistingGap[],
  claims: EmploymentClaim[],
): Array<{ gap_evidence_id: string; filler_evidence_id: string }> {
  const currentKeys = new Set(
    currentGaps.map((g) => `${g.before_evidence_id}|${g.after_evidence_id}`),
  );
  const healed: Array<{ gap_evidence_id: string; filler_evidence_id: string }> = [];
  for (const g of existingGaps) {
    if (g.current_status !== 'VALID') continue;
    if (currentKeys.has(`${g.before_evidence_id}|${g.after_evidence_id}`)) continue; // still open
    const gs = epochDay(g.gap_start);
    const ge = epochDay(g.gap_end);
    const fillers = claims
      .filter(
        (c) =>
          c.current_status === 'VALID' &&
          isFullyDated(c) &&
          // intersects the old gap interior (strictly inside, not just touching the bounds)
          epochDay(c.start_date!) < ge &&
          epochDay(c.end_date!) > gs,
      )
      .sort((p, q) =>
        p.collected_at.getTime() !== q.collected_at.getTime()
          ? p.collected_at.getTime() - q.collected_at.getTime()
          : p.evidence_id < q.evidence_id
            ? -1
            : 1,
      );
    if (fillers.length > 0) {
      healed.push({ gap_evidence_id: g.evidence_id, filler_evidence_id: fillers[0]!.evidence_id });
    }
  }
  return healed;
}

export function computeConsistencyPlan(
  claims: EmploymentClaim[],
  existingGaps: ExistingGap[],
): ConsistencyPlan {
  const currentGaps = computeCurrentGaps(claims);
  // A current gap already recorded (same bounding ids, still VALID) is not re-opened
  // — the service also existence-checks, but filtering here keeps the plan clean.
  const recordedKeys = new Set(
    existingGaps
      .filter((g) => g.current_status === 'VALID')
      .map((g) => `${g.before_evidence_id}|${g.after_evidence_id}`),
  );
  const gapsToOpen = currentGaps.filter(
    (g) => !recordedKeys.has(`${g.before_evidence_id}|${g.after_evidence_id}`),
  );
  return {
    impossibleRangeIds: detectImpossibleRanges(claims),
    employerConflicts: detectEmployerConflicts(claims),
    gapsToOpen,
    gapsToHeal: detectHealedGaps(currentGaps, existingGaps, claims),
  };
}
