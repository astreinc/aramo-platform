export { AuthStorageModule } from './lib/auth-storage.module.js';
export { RefreshTokenService } from './lib/refresh-token.service.js';
export { RotationRaceError } from './lib/refresh-token.repository.js';
export type { RefreshTokenDto } from './lib/dto/refresh-token.dto.js';

// Auth-Decoupling PR-1 — host auth-profile registry surface.
export { HostAuthProfileStore } from './lib/host-auth-profile.store.js';
export { HOST_CLASSES } from './lib/dto/host-auth-profile.dto.js';
export type { HostAuthProfileDto, HostClass } from './lib/dto/host-auth-profile.dto.js';
export {
  SEED_POOL_ID,
  DEFAULT_PLATFORM_HOST,
  DEFAULT_PORTAL_HOST,
  buildHostAuthProfileSeedRows,
  seedHostAuthProfiles,
} from './lib/host-auth-profile.seed.js';
export type {
  HostAuthProfileSeedRow,
  HostAuthProfileSeedClient,
} from './lib/host-auth-profile.seed.js';
