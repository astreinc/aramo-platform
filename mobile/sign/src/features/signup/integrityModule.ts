// Play Integrity is Android only (M-A11 D-2): on any other platform there is no native
// integrity module, so native signup is unavailable. The Android binding is
// integrityModule.android.ts (the bundler picks it by platform extension).
import type { IntegrityModule } from './integrity';

export const integrityModule: IntegrityModule | null = null;
