import { Injectable } from '@nestjs/common';
import { normalizeSkillName } from '@aramo/skills-taxonomy';
import { TalentCanonicalCoverageRepository } from '@aramo/talent-evidence';
import { RequisitionSkillRequirementRepository } from '@aramo/requisition';

// SKILL-TAX-1F-B2 — the platform skill review queue. Surfaces UNRESOLVED surface
// forms across BOTH L3 domains (Talent evidence + requisition requirements) as a
// governance work-list, so a platform operator can decide which surfaces to
// canonicalize (create Skill / add alias / override).
//
// Cross-domain composition WITHOUT cross-schema SQL (ratified): each domain repo
// returns its own unresolved aggregates + INTERNAL distinct tenant membership; this
// apps/api service (the only place that may bridge scope:cip talent-evidence and
// scope:ats requisition) merges them by the AUTHORITATIVE normalized surface form,
// UNIONS the tenant memberships to an exact tenant_count, then DISCARDS the tenant
// ids. Tenant ids may exist transiently here but NEVER appear in the HTTP response —
// the queue is counts-only.
//
// Pagination is a LIVE keyset (no snapshot): order (occurrence_count DESC,
// surface_form ASC); continuation (occurrence_count < c) OR (= c AND surface_form >
// s). The cursor is opaque + versioned and pins the filter fingerprint, so replaying
// a cursor under different filters is rejected. Drift between pages is acceptable
// (the underlying unresolved set moves as reconciliation runs).

export type ReviewQueueSourceDomain = 'talent' | 'requisition';

export interface ReviewQueueQuery {
  sourceDomain?: ReviewQueueSourceDomain;
  minOccurrence?: number;
  surfaceSearch?: string;
  limit: number;
  cursor?: string;
}

export interface ReviewQueueRow {
  // The authoritative normalized surface form (the merge + ordering key).
  surface_form: string;
  occurrence_count: number;
  // Exact distinct tenants across the in-scope domains (ids discarded).
  tenant_count: number;
}

export interface ReviewQueuePage {
  rows: ReviewQueueRow[];
  next_cursor: string | null;
}

export class ReviewQueueCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewQueueCursorError';
  }
}

const CURSOR_VERSION = 1;
// Hard per-domain scan cap. The distinct unresolved-surface cardinality is small
// (one row per distinct surface form, not per evidence row), so this comfortably
// covers real data; if a domain ever returns exactly this many rows we LOG the
// truncation (no silent cap) rather than silently dropping the tail.
const SCAN_LIMIT = 5000;
const MAX_LIMIT = 200;

interface CursorState {
  v: number;
  occurrence_count: number;
  surface_form: string;
  fp: string;
}

// Stable FNV-1a fingerprint over the filter tuple — pins a cursor to the exact
// filters it was minted under (source_domain, min_occurrence, surface-search).
function filterFingerprint(q: ReviewQueueQuery): string {
  const canonical = JSON.stringify({
    d: q.sourceDomain ?? 'all',
    m: q.minOccurrence ?? 0,
    s: (q.surfaceSearch ?? '').trim().toLowerCase(),
  });
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): CursorState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new ReviewQueueCursorError('malformed cursor');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as CursorState).v !== CURSOR_VERSION ||
    typeof (parsed as CursorState).occurrence_count !== 'number' ||
    typeof (parsed as CursorState).surface_form !== 'string' ||
    typeof (parsed as CursorState).fp !== 'string'
  ) {
    throw new ReviewQueueCursorError('unsupported or malformed cursor');
  }
  return parsed as CursorState;
}

@Injectable()
export class SkillReviewQueueService {
  constructor(
    private readonly talentCoverage: TalentCanonicalCoverageRepository,
    private readonly requisitionRequirements: RequisitionSkillRequirementRepository,
  ) {}

  async list(query: ReviewQueueQuery): Promise<ReviewQueuePage> {
    const limit = Math.min(Math.max(1, Math.trunc(query.limit)), MAX_LIMIT);
    const minOccurrence = Math.max(0, Math.trunc(query.minOccurrence ?? 0));
    const fp = filterFingerprint(query);

    let after: CursorState | null = null;
    if (query.cursor !== undefined && query.cursor.length > 0) {
      after = decodeCursor(query.cursor);
      if (after.fp !== fp) {
        throw new ReviewQueueCursorError('cursor filters do not match the current query');
      }
    }

    const surfaceSearch = query.surfaceSearch ?? null;
    const wantTalent = query.sourceDomain === undefined || query.sourceDomain === 'talent';
    const wantRequisition = query.sourceDomain === undefined || query.sourceDomain === 'requisition';

    // Fetch each in-scope domain's unresolved aggregates (with internal tenant
    // membership). Bounded scan per domain; truncation is logged, never silent.
    const [talentAgg, requisitionAgg] = await Promise.all([
      wantTalent
        ? this.talentCoverage.listUnresolvedSurfaceAggregates({ scanLimit: SCAN_LIMIT, surfaceSearch })
        : Promise.resolve([]),
      wantRequisition
        ? this.requisitionRequirements.listUnresolvedSurfaceAggregates({ scanLimit: SCAN_LIMIT, surfaceSearch })
        : Promise.resolve([]),
    ]);
    if (talentAgg.length >= SCAN_LIMIT || requisitionAgg.length >= SCAN_LIMIT) {
      // eslint-disable-next-line no-console
      console.warn(
        JSON.stringify({
          event: 'skill_review_queue_scan_truncated',
          scan_limit: SCAN_LIMIT,
          talent_rows: talentAgg.length,
          requisition_rows: requisitionAgg.length,
        }),
      );
    }

    // Merge by the authoritative normalized surface form; union tenant membership.
    const buckets = new Map<string, { occurrence_count: number; tenants: Set<string> }>();
    const absorb = (agg: Array<{ surface_form: string; occurrence_count: number; tenant_ids: string[] }>) => {
      for (const row of agg) {
        const key = normalizeSkillName(row.surface_form);
        if (key.length === 0) continue;
        let bucket = buckets.get(key);
        if (bucket === undefined) {
          bucket = { occurrence_count: 0, tenants: new Set<string>() };
          buckets.set(key, bucket);
        }
        bucket.occurrence_count += row.occurrence_count;
        for (const t of row.tenant_ids) bucket.tenants.add(t);
      }
    };
    absorb(talentAgg);
    absorb(requisitionAgg);

    // Materialize counts-only rows, drop below min_occurrence, order by the keyset.
    const ordered = [...buckets.entries()]
      .map(([surface_form, b]) => ({
        surface_form,
        occurrence_count: b.occurrence_count,
        tenant_count: b.tenants.size,
      }))
      .filter((r) => r.occurrence_count >= minOccurrence)
      .sort((a, b) =>
        b.occurrence_count - a.occurrence_count || (a.surface_form < b.surface_form ? -1 : a.surface_form > b.surface_form ? 1 : 0),
      );

    // Apply the keyset continuation predicate in-memory over the ordered set.
    const startIndex =
      after === null
        ? 0
        : ordered.findIndex(
            (r) =>
              r.occurrence_count < after.occurrence_count ||
              (r.occurrence_count === after.occurrence_count && r.surface_form > after.surface_form),
          );
    const window = startIndex < 0 ? [] : ordered.slice(startIndex, startIndex + limit);
    const last = window.length > 0 ? window[window.length - 1] : undefined;

    const nextCursor =
      last !== undefined && startIndex >= 0 && startIndex + limit < ordered.length
        ? encodeCursor({
            v: CURSOR_VERSION,
            occurrence_count: last.occurrence_count,
            surface_form: last.surface_form,
            fp,
          })
        : null;

    return { rows: window, next_cursor: nextCursor };
  }
}
