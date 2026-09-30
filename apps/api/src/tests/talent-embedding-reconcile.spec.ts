import { describe, expect, it, vi } from 'vitest';
import type { TalentEmbeddingRepositoryPort } from '@aramo/talent-embedding';

import { TalentEmbeddingReconcileService } from '../embedding/talent-embedding-reconcile.service.js';
import type { EmbeddingProcessingConfig } from '../embedding/embedding-processing.config.js';

// GS-2A Slice-5b — the dark reconcile sweep: enqueues ONLY live Talents lacking an embedding row,
// and is a no-op while the dark flag is off (never scans, never enqueues).

interface Ref {
  tenant_id: string;
  talent_record_id: string;
  site_id: string | null;
}

function make(opts: { enabled: boolean; refs: Ref[] }) {
  const listMissing = vi.fn(async () => opts.refs);
  const enqueue = vi.fn(async () => undefined);
  const repo = { listLiveTalentRefsMissingEmbedding: listMissing, enqueue } as unknown as TalentEmbeddingRepositoryPort;
  const config = { isEnabled: () => opts.enabled } as unknown as EmbeddingProcessingConfig;
  return { svc: new TalentEmbeddingReconcileService(repo, config), enqueue, listMissing };
}

describe('TalentEmbeddingReconcileService (GS-2A Slice-5b)', () => {
  it('is a no-op when the dark flag is off — never queries, never enqueues', async () => {
    const { svc, enqueue, listMissing } = make({ enabled: false, refs: [] });
    expect(await svc.runOnce()).toEqual({ enabled: false, enqueued: 0 });
    expect(listMissing).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('enqueues each live Talent lacking an embedding row and returns the count', async () => {
    const refs: Ref[] = [
      { tenant_id: 't-1', talent_record_id: 'a', site_id: 's-1' },
      { tenant_id: 't-1', talent_record_id: 'b', site_id: null },
    ];
    const { svc, enqueue } = make({ enabled: true, refs });
    expect(await svc.runOnce()).toEqual({ enabled: true, enqueued: 2 });
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledWith({ tenant_id: 't-1', talent_record_id: 'a', site_id: 's-1' });
    expect(enqueue).toHaveBeenCalledWith({ tenant_id: 't-1', talent_record_id: 'b', site_id: null });
  });

  it('enabled with nothing to reconcile → enqueued 0', async () => {
    const { svc, enqueue } = make({ enabled: true, refs: [] });
    expect(await svc.runOnce()).toEqual({ enabled: true, enqueued: 0 });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
