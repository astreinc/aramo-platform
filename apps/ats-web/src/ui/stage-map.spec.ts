import { describe, expect, it } from 'vitest';

import { PIPELINE_STATUS_VALUES } from '../pipeline/types';

import {
  FUNNEL_BUCKETS,
  funnelBucket,
  funnelCounts,
  stageLabel,
  stageTone,
} from './stage-map';

const TONES = ['neutral', 'info', 'brand', 'warn', 'ok', 'danger'];
const BUCKET_KEYS = FUNNEL_BUCKETS.map((b) => b.key);

describe('stage-map', () => {
  // Exhaustiveness: a new BE pipeline status (R1 hand-mirror drift-guarded
  // separately) must not silently fall through the tone/bucket maps.
  it('maps every pipeline status to a known tone', () => {
    for (const s of PIPELINE_STATUS_VALUES) {
      expect(TONES).toContain(stageTone(s));
    }
  });

  it('maps every pipeline status to a known funnel bucket', () => {
    for (const s of PIPELINE_STATUS_VALUES) {
      expect(BUCKET_KEYS).toContain(funnelBucket(s));
    }
  });

  it('applies the stage-pill semantics', () => {
    expect(stageTone('no_contact')).toBe('neutral'); // Sourced
    expect(stageTone('contacted')).toBe('neutral');
    expect(stageTone('talent_responded')).toBe('info');
    expect(stageTone('qualifying')).toBe('info');
    expect(stageTone('qualified')).toBe('info');
    expect(stageTone('not_in_consideration')).toBe('danger');
    expect(stageTone('completed')).toBe('ok');
  });

  it('renders the recruiter-facing label from the pipeline source', () => {
    expect(stageLabel('no_contact')).toBe('No contact');
    expect(stageLabel('completed')).toBe('Completed');
  });

  it('aggregates statuses into ordered pipeline-owned funnel counts', () => {
    const counts = funnelCounts([
      'no_contact',
      'contacted',
      'talent_responded',
      'qualifying',
      'qualified',
      'not_in_consideration',
      'completed',
    ]);
    expect(counts.map((c) => c.key)).toEqual(BUCKET_KEYS);
    const byKey = Object.fromEntries(counts.map((c) => [c.key, c.count]));
    expect(byKey.early_engagement).toBe(2); // no_contact + contacted
    expect(byKey.qualifying).toBe(2); // talent_responded + qualifying
    expect(byKey.qualified).toBe(1);
    expect(byKey.closed).toBe(2); // not_in_consideration + completed
  });

  it('returns zeroed buckets for an empty pipeline', () => {
    const counts = funnelCounts([]);
    expect(counts).toHaveLength(FUNNEL_BUCKETS.length);
    expect(counts.every((c) => c.count === 0)).toBe(true);
  });
});
