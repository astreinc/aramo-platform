// Native signup integrity exists on Android (Play Integrity, integrityModule.android.ts) and
// iOS (App Attest, integrityModule.ios.ts); the bundler picks the file by platform
// extension. Any other platform has no module, so native signup is unavailable there.
import type { IntegrityModule } from './integrity';

export const integrityModule: IntegrityModule | null = null;
