export { AuthorizationModule } from './lib/authorization.module.js';
export { RolesGuard } from './lib/roles.guard.js';
export { RequireScopes } from './lib/require-scopes.decorator.js';
export { RequireSiteMatch } from './lib/require-site-match.decorator.js';
export {
  REQUIRED_SCOPES_KEY,
  REQUIRES_SITE_MATCH_KEY,
} from './lib/authorization.metadata.js';
