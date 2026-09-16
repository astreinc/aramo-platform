// SKILL-TAX-1G — canonical supported-years aggregation (talent-evidence-local,
// pure, deterministic). Groups reconciled TalentSkillEvidence usage intervals by
// canonical_skill_id and computes supported duration by INTERVAL UNION — never by
// summing per-surface totals, so overlapping usages are not double-counted and
// two surface variants that resolve to one canonical Skill (e.g. "K8s" 2020-2022
// + "Kubernetes" 2022-2025) collapse to one union (2020-2025).
//
// This mirrors the union semantics HF2 established in
// libs/talent-extraction/src/lib/skill-usage-timeline.ts (mergeMonthRanges) but is
// re-implemented HERE on the persisted usage_start/usage_end Date columns. It is
// NOT imported from talent-extraction: talent-extraction depends on
// @aramo/talent-evidence, so the reverse import would create an nx cycle.

export interface CanonicalUsageRow {
  canonicalSkillId: string;
  usageStart: Date | null;
  usageEnd: Date | null;
}

export interface CanonicalSkillYears {
  supported_years: number;
  first_used: string | null; // ISO date (YYYY-MM-DD)
  last_used: string | null;
  evidence_count: number;
}

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

function toIsoDate(ms: number): string {
  // @db.Date values are midnight-UTC; format the date portion deterministically.
  return new Date(ms).toISOString().slice(0, 10);
}

// Union of [start,end] millisecond intervals -> total covered milliseconds.
function unionMs(intervals: Array<[number, number]>): number {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const first = sorted[0];
  if (first === undefined) return 0;
  let total = 0;
  let curStart = first[0];
  let curEnd = first[1];
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    if (next === undefined) continue;
    const [s, e] = next;
    if (s <= curEnd) {
      // Overlapping or adjacent -> extend.
      if (e > curEnd) curEnd = e;
    } else {
      total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    }
  }
  total += curEnd - curStart;
  return total;
}

// Round to 2 decimals for stable, comparable output.
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function aggregateCanonicalYears(
  rows: CanonicalUsageRow[],
): Record<string, CanonicalSkillYears> {
  const byCanonical = new Map<
    string,
    { intervals: Array<[number, number]>; minStart: number | null; maxEnd: number | null; count: number }
  >();

  for (const r of rows) {
    if (r.canonicalSkillId === null || r.canonicalSkillId === undefined) continue;
    let bucket = byCanonical.get(r.canonicalSkillId);
    if (bucket === undefined) {
      bucket = { intervals: [], minStart: null, maxEnd: null, count: 0 };
      byCanonical.set(r.canonicalSkillId, bucket);
    }
    bucket.count += 1;
    // Only rows with BOTH bounds contribute to the union duration (never invent).
    if (r.usageStart !== null && r.usageEnd !== null) {
      const s = r.usageStart.getTime();
      const e = r.usageEnd.getTime();
      if (e >= s) {
        bucket.intervals.push([s, e]);
        bucket.minStart = bucket.minStart === null ? s : Math.min(bucket.minStart, s);
        bucket.maxEnd = bucket.maxEnd === null ? e : Math.max(bucket.maxEnd, e);
      }
    }
  }

  const out: Record<string, CanonicalSkillYears> = {};
  for (const [canonicalSkillId, b] of byCanonical) {
    out[canonicalSkillId] = {
      supported_years: round2(unionMs(b.intervals) / MS_PER_YEAR),
      first_used: b.minStart === null ? null : toIsoDate(b.minStart),
      last_used: b.maxEnd === null ? null : toIsoDate(b.maxEnd),
      evidence_count: b.count,
    };
  }
  return out;
}
