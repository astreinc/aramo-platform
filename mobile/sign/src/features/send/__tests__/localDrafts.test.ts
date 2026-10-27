import { createDraftStore } from '../../../state/draftStore';
import { createEncryptedStore } from '../../../state/encryptedStore';
import { memoryFiles, memoryKv, nodeAesGcm } from '../../../testing/fakes';
import { createDocumentBytesStore } from '../documentBytes';
import { forgetLocalDrafts } from '../localDrafts';

function stores() {
  const store = createEncryptedStore({ kv: memoryKv(), cipher: nodeAesGcm, files: memoryFiles() });
  return { drafts: createDraftStore(store), bytes: createDocumentBytesStore(store) };
}

const draft = (localId: string, envelopeId: string | null, docKeys: string[]) => ({
  localId,
  envelopeId,
  baseRevision: null,
  step: 'documents' as const,
  updatedAt: '2026-10-27T10:00:00.000Z',
  payload: { documents: docKeys.map((key) => ({ key })) },
});

describe('forgetLocalDrafts', () => {
  it('removes the drafts linked to the deleted envelope and their document bytes, nothing else', async () => {
    const { drafts, bytes } = stores();
    await drafts.save(draft('local-0001', 'env-a', ['doc-aaaa-0001']));
    await drafts.save(draft('local-0002', 'env-b', ['doc-bbbb-0001']));
    await bytes.put('doc-aaaa-0001', 'QUJD');
    await bytes.put('doc-bbbb-0001', 'REVG');

    expect(await forgetLocalDrafts(drafts, bytes, { envelopeId: 'env-a' })).toBe(1);
    expect((await drafts.list()).map((d) => d.localId)).toEqual(['local-0002']);
    expect(await bytes.get('doc-aaaa-0001')).toBeNull();
    expect(await bytes.get('doc-bbbb-0001')).toBe('REVG');
  });

  it('removes an on-device-only draft by its local id', async () => {
    const { drafts, bytes } = stores();
    await drafts.save(draft('local-0003', null, ['srv-0']));
    expect(await forgetLocalDrafts(drafts, bytes, { localDraftId: 'local-0003' })).toBe(1);
    expect(await drafts.list()).toHaveLength(0);
  });
});
