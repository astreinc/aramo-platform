import { normalizeEmail } from './email-domain.js';

// COG-ATTR-1 (LOCKED 2026-10-27) — the `aramo-platform` user pool requires `profile`,
// `given_name`, `family_name` and `name` (fixed at pool creation). IdP sign-ins fill them;
// an AdminCreateUser that sends only `email` (+ `name`) is refused, so every invite that
// creates a NEW identity failed. Both admin-create paths (platform-admin CognitoAdminService,
// api TenantCognitoAdapter) build their attributes here. Values are derived deterministically
// from what the invite already has — no new input: `name` = the display name, else the email
// local part; `given_name` = its first token; `family_name` = the rest, else `given_name`;
// `profile` = the email (the shape the IdP gives existing users).

export interface CognitoAttribute {
  Name: string;
  Value: string;
}

/** Cognito's per-attribute value limit. */
const MAX_LEN = 2048;

const clip = (v: string): string => v.slice(0, MAX_LEN);

export function cognitoCreateUserAttributes(args: {
  email: string;
  display_name?: string | null;
}): CognitoAttribute[] {
  const email = normalizeEmail(args.email);
  const display = (args.display_name ?? '').trim().replace(/\s+/g, ' ');
  const name = display !== '' ? display : email.split('@')[0] || email;
  const [given = name, ...rest] = name.split(' ');
  const family = rest.length > 0 ? rest.join(' ') : given;
  return [
    { Name: 'email', Value: email },
    { Name: 'email_verified', Value: 'true' },
    { Name: 'name', Value: clip(name) },
    { Name: 'given_name', Value: clip(given) },
    { Name: 'family_name', Value: clip(family) },
    { Name: 'profile', Value: clip(email) },
  ];
}
