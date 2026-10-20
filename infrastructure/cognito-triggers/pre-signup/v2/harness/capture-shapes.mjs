// Builds REDACTED PreSignUp_ExternalProvider event shapes from a private,
// read-only backup of the production pool's users (aws cognito-idp list-users),
// so v2 can be replayed against real attribute shapes without touching Cognito.
//
//   node capture-shapes.mjs <backup>/users-and-identity-links.json > captured-shapes.json
//
// Kept: provider prefix, attribute NAMES, email_verified value, which providers a
// user already has linked. Replaced: every identifier and every email (local
// part and domain) — the output carries no personal data.
import { readFileSync } from 'node:fs';

const users = JSON.parse(readFileSync(process.argv[2], 'utf8')).Users;
const shapes = [];
users.forEach((u, i) => {
  const attrs = Object.fromEntries((u.Attributes ?? []).map((a) => [a.Name, a.Value]));
  const linked = attrs.identities ? JSON.parse(attrs.identities).map((x) => x.providerName) : [];
  const prefix = u.Username.includes('_') ? u.Username.split('_')[0] : null;
  const userAttributes = {};
  for (const name of Object.keys(attrs).sort()) {
    if (name === 'identities' || name === 'sub' || name.startsWith('custom:')) continue;
    if (name === 'email') userAttributes.email = `user${i}@domain${i}.example.test`;
    else if (name === 'email_verified') userAttributes.email_verified = attrs.email_verified;
    else userAttributes[name] = `redacted-${name}`;
  }
  shapes.push({
    id: `user${i}`,
    kind: prefix ?? 'native',
    status: u.UserStatus,
    linked_providers: linked,
    userName: prefix ? `${prefix}_redacted${i}` : `native${i}`,
    userAttributes,
  });
});
process.stdout.write(`${JSON.stringify({ captured_at: new Date().toISOString().slice(0, 10), source: 'list-users (read-only)', shapes }, null, 1)}\n`);
