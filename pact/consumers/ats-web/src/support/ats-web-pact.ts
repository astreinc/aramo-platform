import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';

// PC-2 — shared support module for the ats-web consumer suite (extracted at
// the N=2 trigger, per the charter §5.3 shared-fixture rule). Every ats-web
// domain file (engagement, submittal, …) imports the ctor factory + shared
// constants + the generic error-envelope builder from here; domain-specific
// view/shape builders and constants stay in their own domain file.

export { MatchersV3 };
const { like, uuid, regex } = MatchersV3;
export { like, uuid, regex };

// Shared constants — mirror the provider fixtures in
// pact/provider/src/verify-api.ts (recruiter JWT tenant + PACT talent + the
// fake access cookie the provider requestFilter rewrites to the real JWT).
export const TENANT_ID = '11111111-1111-7111-8111-111111111111';
export const TALENT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
export const ACCESS_COOKIE = 'aramo_access_token=eyJfake.access.token';
// ms-aware, end-anchored ISO pattern (matches the API's
// Date.toISOString() output; same pattern as the ingestion + tenant-console
// pacts).
export const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

// One PactV4 instance per domain file (consumer `ats-web` → provider
// `aramo-core`). Separate instances for the same consumer→provider pair
// MERGE into a single ats-web-aramo-core.json (portal-thin precedent: 2
// files, one pact), so no pactUrls change is needed as domains are added.
export function makeAtsWebProvider(): PactV4 {
  return new PactV4({
    consumer: 'ats-web',
    provider: 'aramo-core',
    dir: resolve(__dirname, '../../../../pacts'),
    logLevel: 'warn',
  });
}

// Generic nested error-envelope builder — the locked Phase-5 shape
// { error: { code, message, request_id, details } }. `code` is pinned
// (exact match); `message` is a like() type-matcher (informational).
export function errorBody(code: string, messageExample: string) {
  return {
    error: {
      code,
      message: like(messageExample),
      request_id: uuid(),
      details: like({}),
    },
  };
}
