// Android: Play Integrity Standard requests through @expo/app-integrity (M-A11 §2.1, §4).
import {
  prepareIntegrityTokenProviderAsync,
  requestIntegrityCheckAsync,
} from '@expo/app-integrity';

import type { IntegrityModule } from './integrity';

export const integrityModule: IntegrityModule | null = {
  prepare: (cloudProjectNumber) => prepareIntegrityTokenProviderAsync(cloudProjectNumber),
  request: (requestHash) => requestIntegrityCheckAsync(requestHash),
};
