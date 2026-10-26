// CCP-B4 — display helpers for the Contracts screen, matching the pinned design's
// helpers (Commercial Control Plane v1.0.dc.html via ccp-data.js `fD`):
// "8 Dec 2026" (UTC, day not padded).

import type { ContractAmendment, ContractDetail, ContractPerson, ContractSummary } from './contracts-api';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 24 * 3600 * 1000;

export function formatDay(iso: string | null): string {
  if (iso === null) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Whole months of a commitment term (rounded on a 30.4375-day month). */
export function commitmentMonths(c: ContractSummary): number | null {
  const { commitment_start: s, commitment_end: e } = c.subscription;
  if (s === null || e === null) return null;
  return Math.round((Date.parse(e) - Date.parse(s)) / (30.4375 * DAY_MS));
}

/** "36 months · ends 8 Dec 2026" (the list row's second line). */
export function contractRowLine(c: ContractSummary): string {
  const m = commitmentMonths(c);
  if (m === null) return c.status === 'ENDED' ? `No commitment term · ended ${formatDay(c.subscription.ended_at)}` : 'No commitment term';
  return `${m} months · ends ${formatDay(c.subscription.commitment_end)}`;
}

/** "sha256:9f2c61d0…a84b1e". */
export function shortHash(sha256: string): string {
  return sha256.length > 14 ? `sha256:${sha256.slice(0, 8)}…${sha256.slice(-6)}` : `sha256:${sha256}`;
}

export function personName(p: ContractPerson): string {
  return p.display_name ?? p.email ?? 'Unknown operator';
}

export interface ContractFact {
  readonly k: string;
  readonly v: string;
  readonly s: string;
}

export function contractFacts(c: ContractDetail, now: number): ContractFact[] {
  const m = commitmentMonths(c);
  const end = c.subscription.commitment_end;
  const endsSub = c.status === 'ENDED' ? 'Ended' : end !== null && Date.parse(end) > now ? `in ${Math.round((Date.parse(end) - now) / DAY_MS)} days` : end !== null ? 'Commitment ended' : 'No commitment term';
  return [
    { k: 'Commitment', v: m === null ? 'None' : `${m} months`, s: m === null ? 'No commitment term' : `${formatDay(c.subscription.commitment_start)} – ${formatDay(end)}` },
    { k: 'Ends', v: formatDay(end ?? c.subscription.ended_at), s: endsSub },
    { k: 'Source', v: 'MANUAL', s: 'Governed contract' },
    c.provenance === 'MIGRATION'
      ? { k: 'Provenance', v: 'Migration', s: 'Backfilled from legacy billing' }
      : { k: 'Provenance', v: 'Recorded', s: 'Entered by Commercial ops' },
  ];
}

export interface TimelineEntry {
  readonly key: string;
  readonly at: string;
  readonly title: string;
  readonly body: string;
  readonly by: string;
}

function amendmentEntry(a: ContractAmendment): TimelineEntry {
  return { key: `a${a.sequence}`, at: a.recorded_at, title: a.kind === 'END' ? 'Contract ended' : `Amendment ${a.sequence}`, body: a.summary, by: personName(a.recorded_by) };
}

/** The amendments timeline, newest first: the recording (or migration), then each amendment / end. */
export function contractTimeline(c: ContractDetail): TimelineEntry[] {
  const m = commitmentMonths(c);
  const recorded: TimelineEntry =
    c.provenance === 'MIGRATION'
      ? { key: 'rec', at: c.recorded_at, title: 'Migrated into the commercial control plane', body: 'Backfilled from legacy billing. Provenance: migration.', by: personName(c.recorded_by) }
      : { key: 'rec', at: c.recorded_at, title: 'Contract recorded', body: m === null ? 'Recorded with its evidence.' : `${m}-month commitment signed.`, by: personName(c.recorded_by) };
  return [recorded, ...c.amendments.map(amendmentEntry)].reverse();
}
