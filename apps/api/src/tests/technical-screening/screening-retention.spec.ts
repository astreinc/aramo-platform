import { describe, expect, it, vi } from 'vitest';

import { ScreeningRetentionService } from '../../technical-screening/screening-retention.service.js';

// TIP-E2E INC-3 A1-8 (R-B) — with no tenant retention policy, a CONFIRMED or
// VOIDED session's AI content and every linked transcript's source + normalized
// artifacts are deleted; a failure is reported per transcript, never absorbed.

function build(failOn?: string) {
  const repo = {
    deleteSessionAiContent: vi.fn().mockResolvedValue({ deleted: 3 }),
    listTranscriptLinks: vi.fn().mockResolvedValue([
      { conversation_transcript_id: 'ct-1' },
      { conversation_transcript_id: 'ct-2' },
    ]),
  };
  const normalization = {
    deleteNormalizedArtifact: vi.fn(async (_t: string, id: string) => {
      if (id === failOn) throw new Error('storage down');
      return {};
    }),
    deleteSourceArtifact: vi.fn().mockResolvedValue({}),
  };
  return { svc: new ScreeningRetentionService(repo as never, normalization as never), repo, normalization };
}

describe('ScreeningRetentionService (A1-8, R-B)', () => {
  it('deletes the AI content and BOTH artifacts of every linked transcript', async () => {
    const { svc, normalization } = build();
    expect(await svc.applyTerminalRetention('t-1', 's-1')).toEqual({
      ai_content_deleted: 3,
      transcripts: [
        { conversation_transcript_id: 'ct-1', status: 'deleted' },
        { conversation_transcript_id: 'ct-2', status: 'deleted' },
      ],
    });
    expect(normalization.deleteNormalizedArtifact.mock.calls.map((c) => c[1])).toEqual(['ct-1', 'ct-2']);
    expect(normalization.deleteSourceArtifact.mock.calls.map((c) => c[1])).toEqual(['ct-1', 'ct-2']);
  });

  it('reports a failed transcript and still processes the rest', async () => {
    const { svc } = build('ct-1');
    expect((await svc.applyTerminalRetention('t-1', 's-1')).transcripts).toEqual([
      { conversation_transcript_id: 'ct-1', status: 'failed' },
      { conversation_transcript_id: 'ct-2', status: 'deleted' },
    ]);
  });
});
