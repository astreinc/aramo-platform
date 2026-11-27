// Runs under vitest and mobile Jest (globals only).
import { PURGE_COPY, PURGE_LEVELS, envelopeDequeuePurgeRoute, envelopePurgeRoute, purgeBannerLine, purgeConfirmed, purgeLevelLabel } from '../index.js';

// APP-DELETED-1 A2 (UAT DEL-10) — one purge copy for web and the app.
describe('purge', () => {
  const fmt = (iso: string | null) => `<${iso}>`;

  it('levels and labels', () => {
    expect(PURGE_LEVELS.map((l) => l.key)).toEqual(['DOCUMENTS', 'DOCUMENTS_AND_METADATA', 'DOCUMENTS_AND_METADATA_AND_REDACT']);
    expect(purgeLevelLabel('DOCUMENTS_AND_METADATA')).toBe('Documents and details');
    expect(purgeLevelLabel(null)).toBe('Documents');
  });

  it('confirms only on the exact word PURGE', () => {
    expect(purgeConfirmed('PURGE')).toBe(true);
    expect(purgeConfirmed('purge')).toBe(false);
    expect(purgeConfirmed('PURGE ')).toBe(false);
  });

  it('banner: queued, executed, none for cancelled or absent', () => {
    expect(purgeBannerLine({ state: 'QUEUED', level: 'DOCUMENTS', due_at: '2026-12-11', executed_at: null }, fmt)).toBe(
      'Purge scheduled: documents will be deleted permanently on <2026-12-11>.',
    );
    expect(purgeBannerLine({ state: 'EXECUTED', level: 'DOCUMENTS', due_at: null, executed_at: '2026-12-11' }, fmt)).toContain('were purged on <2026-12-11> (documents)');
    expect(purgeBannerLine({ state: 'DEQUEUED', level: 'DOCUMENTS', due_at: null, executed_at: null }, fmt)).toBeNull();
    expect(purgeBannerLine(null, fmt)).toBeNull();
  });

  it('routes and wording', () => {
    expect(envelopePurgeRoute('a/b')).toBe('/v1/sign/sender/envelopes/a%2Fb/purge');
    expect(envelopeDequeuePurgeRoute('e1')).toBe('/v1/sign/sender/envelopes/e1/purge/dequeue');
    expect(PURGE_COPY.queued).toBe('Purge scheduled');
    expect(PURGE_COPY.cancelled).toBe('Purge cancelled');
  });
});
