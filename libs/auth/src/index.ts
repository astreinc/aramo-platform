export { AuthModule } from './lib/auth.module.js';
export { JwtAuthGuard } from './lib/jwt-auth.guard.js';
export { AuthContext } from './lib/auth-context.decorator.js';
export {
  ACTOR_KINDS,
  CONSUMER_TYPES,
  PLATFORM_TENANT_SENTINEL_ID,
  type ActorKind,
  type AuthContext as AuthContextType,
  type ConsumerType,
} from './lib/auth-context.types.js';
// HF-AUTH-1 — the app-layer authorization-resolution port (bound at each app's
// composition root to an identity-backed, Redis-cached, fail-closed resolver).
export {
  EFFECTIVE_AUTHORIZATION_RESOLVER,
  type EffectiveAuthorizationInput,
  type EffectiveAuthorizationResolution,
  type EffectiveAuthorizationResolver,
} from './lib/effective-authorization-resolver.port.js';
