import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';

// Event shapes follow Cognito's PreSignUp_ExternalProvider trigger: the
// userName is "<provider>_<provider user id>" and userAttributes carry the
// pool's attribute mapping (Google email_verified; microsoft xms_edov →
// email_verified).
function event(userName, userAttributes, triggerSource = 'PreSignUp_ExternalProvider') {
  return {
    version: '1',
    region: 'us-east-1',
    userPoolId: 'us-east-1_TEST',
    userName,
    triggerSource,
    callerContext: { awsSdkVersion: 'aws-sdk-unknown-unknown', clientId: 'client' },
    request: { userAttributes },
    response: { autoConfirmUser: false, autoVerifyEmail: false, autoVerifyPhone: false },
  };
}

let handler;
let logs;
beforeEach(async () => {
  logs = [];
  console.log = (line) => logs.push(JSON.parse(line));
  delete process.env.REQUIRE_PROVIDER_EMAIL_VERIFIED;
  delete process.env.ALLOWED_PROVIDERS;
  ({ handler } = await import(`./index.mjs?t=${Math.random()}`));
});

test('Google first sign-in with a provider-verified email is allowed, unchanged', async () => {
  const e = event('google_109239000000000000001', { email: 'owner@acme-workspace.test', email_verified: 'true', sub: 'x' });
  const out = await handler(structuredClone(e));
  assert.deepEqual(out.response, e.response);
  assert.deepEqual(logs, [{ trigger: 'pre-signup-v2', decision: 'allowed', provider: 'google', email_domain: 'acme-workspace.test', provider_email_verified: true }]);
});

test('Microsoft first sign-in with xms_edov-mapped verification is allowed, unchanged', async () => {
  const e = event('microsoft_CIcScTabc', { email: 'owner@contoso.test', email_verified: 'true' });
  const out = await handler(structuredClone(e));
  assert.equal(out.response.autoVerifyEmail, false);
  assert.equal(out.response.autoConfirmUser, false);
});

test('an unverified provider email is refused before any user is created', async () => {
  await assert.rejects(handler(event('microsoft_abc', { email: 'owner@contoso.test', email_verified: 'false' })), /not verified/);
  await assert.rejects(handler(event('google_123', { email: 'owner@acme.test' })), /not verified/);
  assert.equal(logs.at(-1).decision, 'refused_unverified_email');
});

test('never sets autoVerifyEmail, never manufactures verification', async () => {
  const out = await handler(event('google_1', { email: 'a@b.test', email_verified: 'true' }));
  assert.equal(out.response.autoVerifyEmail, false);
});

test('an unknown provider or a missing email is refused', async () => {
  await assert.rejects(handler(event('facebook_1', { email: 'a@b.test', email_verified: 'true' })), /not permitted/);
  await assert.rejects(handler(event('nounderscore', { email: 'a@b.test', email_verified: 'true' })), /not permitted/);
  await assert.rejects(handler(event('google_1', { email_verified: 'true' })), /did not share/);
});

test('native (admin-created) sign-ups and other trigger sources pass through untouched', async () => {
  const e = event('owner@acme.test', { email: 'owner@acme.test' }, 'PreSignUp_AdminCreateUser');
  assert.deepEqual(await handler(structuredClone(e)), e);
  assert.equal(logs.length, 0);
});

test('the verification requirement is a documented, explicit switch', async () => {
  process.env.REQUIRE_PROVIDER_EMAIL_VERIFIED = 'false';
  ({ handler } = await import(`./index.mjs?t=${Math.random()}`));
  const out = await handler(event('microsoft_x', { email: 'a@b.test' }));
  assert.equal(out.response.autoVerifyEmail, false);
  assert.equal(logs.at(-1).provider_email_verified, false);
});

test('the module contains no Cognito API calls (no linking, no subject substitution)', async () => {
  const { readFileSync } = await import('node:fs');
  // Code only: comments document the forbidden calls by name.
  const src = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  assert.equal(/AdminLinkProviderForUser|client-cognito-identity-provider|autoVerifyEmail\s*=\s*true/.test(src), false);
});
