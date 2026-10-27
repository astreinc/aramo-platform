// One-time swipe hint ("Swipe left on an agreement…", handoff §2A). The dismissal is
// kept in the app's encrypted on-device store (state/encryptedStore.ts), so it is
// per user: sign-out wipes the store and the hint shows again for the next user.
// Shared by Home and Agreements so "Got it" on either hides it on both.
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useServices } from '../../app/ServicesContext';
import type { EncryptedStore } from '../../state/encryptedStore';

export const SWIPE_HINT_SLOT = 'ui.swipe-hint-dismissed';
export const SWIPE_HINT_TEXT = 'Swipe left on an agreement to sign, remind, void or delete it.';
const KEY = ['sign', 'ui', 'swipe-hint'] as const;

export async function isSwipeHintDismissed(store: EncryptedStore): Promise<boolean> {
  try {
    return (await store.get(SWIPE_HINT_SLOT)) === '1';
  } catch {
    // An unreadable slot only re-shows a hint.
    return false;
  }
}

export async function dismissSwipeHint(store: EncryptedStore): Promise<void> {
  await store.set(SWIPE_HINT_SLOT, '1');
}

/** { visible, dismiss }: hidden until the stored answer is known (no flash). */
export function useSwipeHint(): { visible: boolean; dismiss: () => void } {
  const { store } = useServices();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: KEY,
    queryFn: () => isSwipeHintDismissed(store),
    staleTime: Infinity,
  });
  return {
    visible: q.data === false,
    dismiss: () => {
      qc.setQueryData(KEY, true);
      void dismissSwipeHint(store).catch(() => undefined);
    },
  };
}
