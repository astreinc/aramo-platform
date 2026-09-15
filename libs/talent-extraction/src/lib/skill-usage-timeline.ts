// HF2 R14/R15 + R27 — deterministic skill-timeline derivation from SkillUsage
// evidence, computed ONLY on NORMALIZED, precision-carrying dates (R27). No loose
// `new Date(string)` ever feeds this math: callers pass ResumeDate values from
// the canonical strict parser (resume-date.ts), and an unparseable date is null
// (contributes nothing) — never a fabricated day. Overlapping intervals are
// UNIONED, not summed (R14). The derived precision is the COARSEST input
// precision, so a year-only span is honestly flagged approximate, never
// presented as exact. `asOf` is injected for determinism.

import {
  type ResumeDate,
  type ResumeDatePrecision,
  coarsestPrecision,
  resumeDateToMonthIndex,
} from './resume-date.js';

export interface SkillUsageInterval {
  readonly start: ResumeDate | null;
  readonly end: ResumeDate | null;
  // Open-ended ("present") — the end extends to asOf.
  readonly ongoing: boolean;
}

export interface SkillTimeline {
  readonly first_used: ResumeDate | null;
  readonly last_used: ResumeDate | null;
  readonly current_usage: boolean;
  // Union duration in whole months (concurrent ranges counted once).
  readonly supported_months: number;
  // Coarsest precision across contributing intervals — the derived duration is
  // only as trustworthy as its least-precise input (null = nothing contributed).
  readonly precision: ResumeDatePrecision | null;
}

function mergeMonthRanges(ranges: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const sorted = [...ranges].filter(([s, e]) => e >= s).sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    // Adjacent (gap ≤ 1 month) counts continuous — 2020-ending + 2020-starting is
    // one span (R14 example: 2018–2020, 2020–2023 → 2018–2023).
    if (last !== undefined && s <= last[1] + 1) {
      if (e > last[1]) last[1] = e;
    } else {
      out.push([s, e]);
    }
  }
  return out;
}

function monthIndexToYm(idx: number): { year: number; month: number } {
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

export function deriveSkillTimeline(
  usages: readonly SkillUsageInterval[],
  asOf: ResumeDate,
): SkillTimeline {
  const withStart = usages.filter((u) => u.start !== null);
  if (withStart.length === 0) {
    return { first_used: null, last_used: null, current_usage: false, supported_months: 0, precision: null };
  }

  const current_usage = withStart.some((u) => u.ongoing);
  const ranges: Array<[number, number]> = [];
  let firstStartIdx = Number.POSITIVE_INFINITY;
  let firstStart: ResumeDate | null = null;
  let lastEndIdx = Number.NEGATIVE_INFINITY;
  let lastEnd: ResumeDate | null = null;
  let precision: ResumeDatePrecision | null = null;

  for (const u of withStart) {
    const start = u.start as ResumeDate;
    // End: ongoing → asOf; else the stated end; else the start (a single point).
    const end: ResumeDate = u.ongoing ? asOf : (u.end ?? start);
    const sIdx = resumeDateToMonthIndex(start, 'start');
    const eIdx = resumeDateToMonthIndex(end, 'end');
    ranges.push([sIdx, eIdx]);

    if (sIdx < firstStartIdx) { firstStartIdx = sIdx; firstStart = start; }
    if (eIdx > lastEndIdx) { lastEndIdx = eIdx; lastEnd = end; }

    // Precision degrades to the coarsest of every contributing boundary.
    precision = precision === null ? start.precision : coarsestPrecision(precision, start.precision);
    if (!u.ongoing && u.end !== null) precision = coarsestPrecision(precision, u.end.precision);
  }

  const merged = mergeMonthRanges(ranges);
  const supported_months = merged.reduce((sum, [s, e]) => sum + (e - s), 0);

  return {
    first_used: firstStart,
    last_used: lastEnd,
    current_usage,
    supported_months,
    precision,
  };
}

// Convenience for callers that hold month-index results (unused by the core math;
// exported for telemetry/formatting).
export { monthIndexToYm };
