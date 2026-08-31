// Per-requisition pipeline rollup — the single home for the "Pipeline" and
// "Submitted" counts the Requisitions list and the My-desk table both render.
// Derived from an unfiltered /v1/pipelines call (every pipeline across the
// actor's visible requisitions); grouped by requisition_id client-side so the
// surfaces share ONE call, not N+1, and can never drift on the bucket rules.

import { funnelCounts, type FunnelBucketKey } from '../ui';

import { CLOSED_STATUSES, type PipelineStatus, type PipelineView } from './types';

export interface ReqPipelineCount {
  // Active = pipelines still moving (not at a terminal stage).
  readonly active: number;
}

const TERMINAL = new Set<PipelineStatus>(CLOSED_STATUSES);

// E6 Q-4 — the live/terminal partition for the current-episode collapse. Matches
// the server's `Pipeline_live_episode_key` predicate — the canonical-terminals-only
// exclusion set `status NOT IN ('not_in_consideration','completed')`. A terminal
// episode never wins as "live" over a live one.
const COLLAPSE_TERMINAL = new Set<PipelineStatus>([
  'completed',
  'not_in_consideration',
]);

// E6 Q-4 — collapse coexisting episodes to ONE current episode per (talent,
// requisition): the LIVE episode if any (Q-2 guarantees at most one), else the
// latest terminal (created_at DESC, id DESC — deterministic). BUSINESS/person
// views count the collapsed set so a re-entered talent is not double-counted;
// episode/history timelines must NEVER call this (they show every episode).
export function collapseToCurrentEpisode(
  pipelines: readonly PipelineView[],
): PipelineView[] {
  const best = new Map<string, PipelineView>();
  for (const p of pipelines) {
    const key = `${p.talent_record_id} ${p.requisition_id}`;
    const cur = best.get(key);
    if (cur === undefined || preferEpisode(p, cur)) best.set(key, p);
  }
  return [...best.values()];
}

function preferEpisode(a: PipelineView, b: PipelineView): boolean {
  const aLive = !COLLAPSE_TERMINAL.has(a.status);
  const bLive = !COLLAPSE_TERMINAL.has(b.status);
  if (aLive !== bLive) return aLive; // live wins over terminal
  if (a.created_at !== b.created_at) return a.created_at > b.created_at; // latest
  return a.id > b.id; // deterministic final tiebreak
}

export function rollupByRequisition(
  pipelines: readonly PipelineView[],
): Record<string, ReqPipelineCount> {
  const byReq: Record<string, ReqPipelineCount> = {};
  for (const p of collapseToCurrentEpisode(pipelines)) {
    const cur = byReq[p.requisition_id] ?? { active: 0 };
    byReq[p.requisition_id] = {
      active: cur.active + (TERMINAL.has(p.status) ? 0 : 1),
    };
  }
  return byReq;
}

// Per-requisition FUNNEL breakdown — the 6-bucket {label,count} cells the
// Requisitions list's stat block + distribution bar both read. Same ONE
// /v1/pipelines call, grouped by requisition_id (never N+1); the bucket rules
// live once in stage-map's funnelCounts so this can't drift from the detail
// ribbon. `total` is every pipeline entry on the req (matches the detail
// sidecard's "In pipeline"). A req with no entries is simply absent from the
// map — the caller renders an all-zero funnel.
export interface ReqFunnel {
  readonly total: number;
  readonly cells: readonly {
    key: FunnelBucketKey;
    label: string;
    count: number;
  }[];
}

export function funnelByRequisition(
  pipelines: readonly PipelineView[],
): Record<string, ReqFunnel> {
  const byReq: Record<string, PipelineStatus[]> = {};
  // E6 Q-4 — one current episode per (talent, req): `total` is the distinct-talent
  // count on the req and each talent lands in exactly one funnel cell (its current
  // stage), never once per historical episode.
  for (const p of collapseToCurrentEpisode(pipelines)) {
    (byReq[p.requisition_id] ??= []).push(p.status);
  }
  const out: Record<string, ReqFunnel> = {};
  for (const [reqId, statuses] of Object.entries(byReq)) {
    out[reqId] = { total: statuses.length, cells: funnelCounts(statuses) };
  }
  return out;
}
