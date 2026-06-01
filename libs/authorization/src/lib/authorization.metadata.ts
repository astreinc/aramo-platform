// Reflect-metadata keys used by the @RequireScopes / @RequireSiteMatch
// decorators and read by RolesGuard. Defined here (not exported as
// constants from the decorator files) so guard + decorator agree on the
// same string keys without import cycles.
export const REQUIRED_SCOPES_KEY = 'aramo:authorization:required_scopes';
export const REQUIRES_SITE_MATCH_KEY = 'aramo:authorization:requires_site_match';
