import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, test } from 'node:test';

// Production-first ruling step 3 — replay v2 against REDACTED event shapes
// captured read-only from the production pool (capture-shapes.mjs). Local and
// non-mutating: v2 imports no AWS SDK, so nothing here can reach Cognito.
const { shapes } = JSON.parse(readFileSync(new URL('./captured-shapes.json', import.meta.url), 'utf8'));
const federated = shapes.filter((s) => s.kind === 'microsoft' || s.kind === 'google');

function event(userName, userAttributes) {
  return {
    version: '1',
    region: 'us-east-1',
    userPoolId: 'us-east-1_REPLAY',
    userName,
    triggerSource: 'PreSignUp_ExternalProvider',
    callerContext: { awsSdkVersion: 'aws-sdk-unknown-unknown', clientId: 'client' },
    request: { userAttributes: { ...userAttributes } },
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
  ({ handler } = await import(`../index.mjs?t=${Math.random()}`));
});

test('the capture holds the production shapes (federated users present, no personal data)', () => {
  assert.ok(federated.length > 0);
  const text = JSON.stringify(shapes);
  assert.doesNotMatch(text, /@(?!domain\d+\.example\.test)/);
});

test('each captured federated shape, as a first sign-in, is allowed and left unchanged (no verification manufactured)', async () => {
  for (const s of federated) {
    const e = event(s.userName, s.userAttributes);
    const out = await handler(structuredClone(e));
    assert.deepEqual(out.response, e.response, s.id);
  }
});

test('the same email arriving from the OTHER provider creates no link: allowed as its own user, response unchanged', async () => {
  for (const s of federated) {
    const other = s.kind === 'microsoft' ? 'google' : 'microsoft';
    const out = await handler(event(`${other}_crossprovider`, s.userAttributes));
    assert.equal(out.response.autoVerifyEmail, false, s.id);
    assert.equal(logs.at(-1).decision, 'allowed', s.id);
  }
});

test('a Microsoft shape WITHOUT the xms_edov-mapped claim is refused (no user created)', async () => {
  const ms = federated.find((s) => s.kind === 'microsoft');
  const { email_verified: _drop, ...attrs } = ms.userAttributes;
  await assert.rejects(handler(event(ms.userName, attrs)), /not verified/);
  assert.equal(logs.at(-1).decision, 'refused_unverified_email');
});

test('the existing Google->Microsoft link is in the capture and v2 has no code path that edits links', () => {
  assert.ok(shapes.some((s) => s.linked_providers.includes('Google') && s.linked_providers.includes('microsoft')));
  const src = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /AdminLinkProviderForUser|AdminDisableProviderForUser|@aws-sdk/);
});
