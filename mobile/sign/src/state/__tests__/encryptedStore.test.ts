import { SECURE_KEYS } from '../../auth/secureKeyValue';
import { memoryFiles, memoryKv, nodeAesGcm } from '../../testing/fakes';
import { createDraftStore } from '../draftStore';
import { createEncryptedStore } from '../encryptedStore';

function setup() {
  const kv = memoryKv();
  const files = memoryFiles();
  const store = createEncryptedStore({ kv, cipher: nodeAesGcm, files });
  return { kv, files, store, drafts: createDraftStore(store) };
}

const DRAFT = {
  localId: '0c8f2a1e-1111-4222-8333-444455556666',
  envelopeId: null,
  baseRevision: null,
  step: 'recipients' as const,
  updatedAt: '2026-10-25T08:00:00.000Z',
  payload: {
    subject: 'Offer letter — Dana',
    recipients: [{ name: 'Dana', email: 'dana@example.com' }],
  },
};

describe('encrypted draft store (directive §9)', () => {
  it('persists ciphertext only; the key lives in SecureStore', async () => {
    const t = setup();
    await t.drafts.save(DRAFT);
    const onDisk = [...t.files.files.values()].join('');
    expect(onDisk).not.toContain('Dana');
    expect(onDisk).not.toContain('dana@example.com');
    expect(t.kv.items.get(SECURE_KEYS.storageKey)).toBeDefined();
    await expect(t.drafts.load(DRAFT.localId)).resolves.toEqual(DRAFT);
  });

  it('survives a restart (a new store instance over the same key + files)', async () => {
    const t = setup();
    await t.drafts.save(DRAFT);
    const reopened = createDraftStore(
      createEncryptedStore({ kv: t.kv, cipher: nodeAesGcm, files: t.files }),
    );
    await expect(reopened.list()).resolves.toEqual([DRAFT]);
  });

  it('binds ciphertext to its slot (a moved file does not decrypt) and drops tampered data', async () => {
    const t = setup();
    await t.store.set('draft.a1b2c3d4', 'secret');
    t.files.files.set('draft.e5f6a7b8', t.files.files.get('draft.a1b2c3d4')!);
    await expect(t.store.get('draft.e5f6a7b8')).resolves.toBeNull();
    expect(t.files.files.has('draft.e5f6a7b8')).toBe(false);
  });

  it('wipe() removes every slot and the key', async () => {
    const t = setup();
    await t.drafts.save(DRAFT);
    await t.store.set('query-cache', '{}');
    await t.store.wipe();
    expect(t.files.files.size).toBe(0);
    expect(t.kv.items.has(SECURE_KEYS.storageKey)).toBe(false);
  });

  it('rejects unsafe slot and draft ids', async () => {
    const t = setup();
    await expect(t.store.set('../escape', 'x')).rejects.toThrow('invalid storage slot');
    await expect(t.drafts.load('../../x')).rejects.toThrow('invalid draft id');
  });
});
