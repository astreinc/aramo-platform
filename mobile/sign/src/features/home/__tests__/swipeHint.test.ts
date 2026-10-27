import type { EncryptedStore } from '../../../state/encryptedStore';
import { dismissSwipeHint, isSwipeHintDismissed, SWIPE_HINT_SLOT } from '../swipeHint';

function memoryStore(): EncryptedStore {
  const m = new Map<string, string>();
  return {
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => {
      m.set(k, v);
    },
    remove: async (k) => {
      m.delete(k);
    },
    slots: async () => [...m.keys()],
    wipe: async () => m.clear(),
  };
}

describe('swipe hint persistence', () => {
  it('shows until dismissed, then stays dismissed; a wipe (sign-out) shows it again', async () => {
    const s = memoryStore();
    expect(await isSwipeHintDismissed(s)).toBe(false);
    await dismissSwipeHint(s);
    expect(await s.get(SWIPE_HINT_SLOT)).toBe('1');
    expect(await isSwipeHintDismissed(s)).toBe(true);
    await s.wipe();
    expect(await isSwipeHintDismissed(s)).toBe(false);
  });

  it('an unreadable slot only re-shows the hint', async () => {
    const s = { ...memoryStore(), get: async () => Promise.reject(new Error('decrypt')) };
    expect(await isSwipeHintDismissed(s)).toBe(false);
  });
});
