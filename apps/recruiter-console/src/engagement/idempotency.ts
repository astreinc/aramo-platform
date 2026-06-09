// uuidv4 — small inline helper (mirrors the SubmittalWizard idiom; kept
// LOCAL to the engagement module to avoid a cross-module import). We avoid
// pulling a uuid lib for one call.
export function uuidv4(): string {
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return globalThis.crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID; vanishingly rare
  // in modern browsers + Node 19+. Pseudo-random; safe for idempotency-key
  // purposes (we just need uniqueness per operation).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
