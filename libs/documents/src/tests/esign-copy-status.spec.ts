import { describe, expect, it, vi } from 'vitest';

import { DocumentsRepository } from '../lib/documents.repository.js';

// Retention and Purge directive (ebd41d99) W11 — Aramo Sign copy status derived from DocumentEvents.

const T = '2026-11-01T00:00:00.000Z';
const ev = (document_id: string, event_type: string, payload: unknown, at = T) => ({ document_id, event_type, payload, occurred_at: new Date(at) });

function repoWith(events: unknown[]) {
  const findMany = vi.fn().mockResolvedValue(events);
  const prisma = { documentEvent: { findMany } };
  return { repo: new DocumentsRepository(prisma as never, {} as never), findMany };
}

describe('DocumentsRepository.esignCopyStatuses', () => {
  it('no query for no documents', async () => {
    const { repo, findMany } = repoWith([]);
    expect((await repo.esignCopyStatuses('t', [])).size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('native Aramo Sign execution is held; an external provider execution is not', async () => {
    const { repo } = repoWith([
      ev('a', 'DOCUMENT_EXECUTED', { executed_sha256: 'x', certificate_sha256: 'c' }),
      ev('b', 'DOCUMENT_EXECUTED', { executed_sha256: 'x', evidence_sha256: 'e', provider: 'docusign' }),
    ]);
    const m = await repo.esignCopyStatuses('t', ['a', 'b']);
    expect(m.get('a')).toEqual({ status: 'held', at: null });
    expect(m.has('b')).toBe(false);
  });

  it('queued → purge_scheduled, dequeued → held, executed → purged (final)', async () => {
    const { repo } = repoWith([
      ev('a', 'DOCUMENT_EXECUTED', { certificate_sha256: 'c' }, '2026-10-01T00:00:00Z'),
      ev('a', 'ESIGN_SOURCE_COPY_PURGE_STATE', { purge_state: 'documents_queued' }, '2026-10-02T00:00:00Z'),
      ev('b', 'DOCUMENT_EXECUTED', { certificate_sha256: 'c' }, '2026-10-01T00:00:00Z'),
      ev('b', 'ESIGN_SOURCE_COPY_PURGE_STATE', { purge_state: 'documents_and_metadata_queued' }, '2026-10-02T00:00:00Z'),
      ev('b', 'ESIGN_SOURCE_COPY_PURGE_STATE', { purge_state: 'documents_dequeued' }, '2026-10-03T00:00:00Z'),
      ev('c', 'ESIGN_SOURCE_COPY_PURGE_STATE', { purge_state: 'documents_queued' }, '2026-10-02T00:00:00Z'),
      ev('c', 'ESIGN_SOURCE_COPY_PURGED', { purge_state: 'executed' }, '2026-10-16T00:00:00Z'),
      ev('c', 'ESIGN_SOURCE_COPY_PURGE_STATE', { purge_state: 'documents_dequeued' }, '2026-10-17T00:00:00Z'),
    ]);
    const m = await repo.esignCopyStatuses('t', ['a', 'b', 'c']);
    expect(m.get('a')).toEqual({ status: 'purge_scheduled', at: '2026-10-02T00:00:00.000Z' });
    expect(m.get('b')).toEqual({ status: 'held', at: null });
    expect(m.get('c')).toEqual({ status: 'purged', at: '2026-10-16T00:00:00.000Z' });
  });
});
