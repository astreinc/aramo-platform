// Send flow toasts (handoff §5).

/** "Sent to {n} signers" after a successful send. */
export function sentToast(n: number): string {
  return `Sent to ${n} ${n === 1 ? 'signer' : 'signers'}`;
}

export const SAVED_TO_DRAFTS = 'Saved to Drafts';
export const SAVED_ON_DEVICE = 'Saved on this phone. It syncs when you’re online.';
