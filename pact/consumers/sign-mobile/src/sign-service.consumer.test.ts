import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';

const { like, uuid, integer, boolean, eachLike, regex } = MatchersV3;

// Aramo Sign Mobile — Pact consumer for the Sign routes the native app calls
// (directive §4 B-12; M-A3 §1–§9; M-A2 §2.2).
//
// Consumer:  sign-mobile   (mobile/sign — the native app)
// Provider:  sign-service  (apps/sign-service)
//
// Its own pact file, pact/pacts/sign-mobile-sign-service.json, verified by
// pact/provider/src/verify-sign.ts — counted separately from the sign-mobile →
// aramo-auth-service pact (native-auth.consumer.test.ts, verified by verify.ts).
//
// Every request carries a native access token: `Authorization: Bearer <placeholder>`
// plus `X-Aramo-Consumer: sign`. The provider's request filter swaps the
// placeholder for a real RS256 `sign` token of the seeded sender with the native
// claims `client: 'native'` and `dsid` (M-A1 §3.6). The fixed ids MUST match the
// state handlers in pact/provider/src/verify-sign.ts; each mutating op names its
// OWN envelope (SignatureEvent is append-only — nothing is re-seeded).
//
// Interactions:
//   1. GET    /v1/sign/me/notifications                 200 { items, next_cursor }
//   2. GET    /v1/sign/me/notifications/unread-count    200 { count }
//   3. PUT    /v1/sign/me/devices/current               204 (the token's device session)
//   4. GET    /v1/sign/me/notification-preferences      200
//   5. PUT    /v1/sign/me/notification-preferences      200 (echoed)
//   6. GET    /v1/sign/me/signature                     200 { signature, initials }
//   7. PUT    /v1/sign/me/signature                     200 SavedSignature
//   8. POST   /v1/sign/sender/contacts                  201 SenderContact
//   9. GET    /v1/sign/sender/envelopes/{id}            200 detail + ETag "{id}.{revision}"
//  10. PATCH  /v1/sign/sender/envelopes/{id} (If-Match) 200 detail + the next ETag
//  11. POST   /v1/sign/sender/envelopes/{id}/remind     429 reminder_cooldown (retry_after)
//  12. GET    /v1/sign/inbox                            200 { waiting, completed, other }
//  13. DELETE /v1/sign/sender/envelopes/{id} (If-Match) 204

const provider = new PactV4({
  consumer: 'sign-mobile',
  provider: 'sign-service',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

// MUST match pact/provider/src/verify-sign.ts.
const NATIVE_BEARER = 'Bearer pact-native-sign-access-token';
const AUTH = { Authorization: NATIVE_BEARER, 'X-Aramo-Consumer': 'sign' };
const JSON_AUTH = { ...AUTH, 'Content-Type': 'application/json' };
const NOTIFICATION_ID = 'e6000000-0000-7000-8000-000000000011';
const DETAIL_ENVELOPE_ID = 'e6000000-0000-7000-8000-0000000000a1';
const PATCH_ENVELOPE_ID = 'e6000000-0000-7000-8000-0000000000b1';
const DELETE_ENVELOPE_ID = 'e6000000-0000-7000-8000-0000000000c1';
const REMIND_ENVELOPE_ID = 'e6000000-0000-7000-8000-0000000000d1';
const REMIND_SIGNER_ID = 'e6000000-0000-7000-8000-0000000000d3';
const INBOX_BINDING_ID = 'e6000000-0000-7000-8000-0000000000e9';
// A seeded DRAFT (envelope row + one ledger event, separate transactions) is at
// revision 2 (M-A3 §6: one raise per writing transaction).
const DRAFT_REVISION = 2;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const ISO = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$';
const iso = (example: string) => regex(ISO, example);
const etagOf = (envelopeId: string, example: number) => regex(`^"${envelopeId}\\.\\d+"$`, `"${envelopeId}.${example}"`);

function errorBody(code: string, details: Record<string, unknown>) {
  return { error: { code, message: like('message'), request_id: like('req-1'), details } };
}

describe('sign-mobile → notifications (M-A3 §1)', () => {
  it('lists the caller’s notification feed', async () => {
    await provider
      .addInteraction()
      .given('a sign-mobile user has an unread notification')
      .uponReceiving('a native notification feed read')
      .withRequest('GET', '/v1/sign/me/notifications', (b) => {
        b.headers(AUTH).query({ limit: '20' });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          items: eachLike({
            id: uuid(NOTIFICATION_ID),
            type: regex('^(SIGNED|VIEWED|DECLINED|SIGNATURE_NEEDED|COMPLETED|EXPIRED|REMINDER)$', 'SIGNED'),
            envelope_id: uuid(DETAIL_ENVELOPE_ID),
            inbox_item_id: null,
            envelope_subject: like('Offer letter'),
            actor_name: like('Jane Doe'),
            created_at: iso('2026-10-25T10:00:00.000Z'),
            read_at: null,
          }),
          next_cursor: null,
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/me/notifications?limit=20`, { headers: AUTH });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: unknown[] };
        expect(body.items.length).toBeGreaterThan(0);
      });
  });

  it('reads the unread count (the app badge)', async () => {
    await provider
      .addInteraction()
      .given('a sign-mobile user has an unread notification')
      .uponReceiving('a native unread-count read')
      .withRequest('GET', '/v1/sign/me/notifications/unread-count', (b) => {
        b.headers(AUTH);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ count: integer(1) });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/me/notifications/unread-count`, { headers: AUTH });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { count: number }).count).toBeGreaterThanOrEqual(0);
      });
  });
});

describe('sign-mobile → push device and preferences (M-A3 §2)', () => {
  it('registers the native push token on the token’s own device session', async () => {
    const body = { platform: 'ios', provider: 'apns', push_token: 'a1'.repeat(32), app_version: '1.0.0' };
    await provider
      .addInteraction()
      .given('an esign sender session exists')
      .uponReceiving('a native push device registration')
      .withRequest('PUT', '/v1/sign/me/devices/current', (b) => {
        b.headers(JSON_AUTH).jsonBody(body);
      })
      .willRespondWith(204)
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/me/devices/current`, { method: 'PUT', headers: JSON_AUTH, body: JSON.stringify(body) });
        expect(res.status).toBe(204);
      });
  });

  const prefs = { signed: true, viewed: false, declined: true, signature_needed: true, reminders: true, lock_screen_subject: false };

  it('reads the notification preferences', async () => {
    await provider
      .addInteraction()
      .given('an esign sender session exists')
      .uponReceiving('a native notification preferences read')
      .withRequest('GET', '/v1/sign/me/notification-preferences', (b) => {
        b.headers(AUTH);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          signed: boolean(true),
          viewed: boolean(true),
          declined: boolean(true),
          signature_needed: boolean(true),
          reminders: boolean(true),
          lock_screen_subject: boolean(false),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/me/notification-preferences`, { headers: AUTH });
        expect(res.status).toBe(200);
      });
  });

  it('replaces the notification preferences (echoed)', async () => {
    await provider
      .addInteraction()
      .given('an esign sender session exists')
      .uponReceiving('a native notification preferences update')
      .withRequest('PUT', '/v1/sign/me/notification-preferences', (b) => {
        b.headers(JSON_AUTH).jsonBody(prefs);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(prefs);
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/me/notification-preferences`, { method: 'PUT', headers: JSON_AUTH, body: JSON.stringify(prefs) });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(prefs);
      });
  });
});

describe('sign-mobile → saved signature (M-A3 §4)', () => {
  const typed = { kind: 'TYPED', typed_name: 'Sam Sender', font_key: 'caveat', image_data_url: PNG };
  const savedView = {
    kind: 'TYPED',
    typed_name: like('Sam Sender'),
    font_key: like('caveat'),
    image_data_url: regex('^data:image/(png|jpeg);base64,[A-Za-z0-9+/=]+$', PNG),
    updated_at: iso('2026-10-25T10:00:00.000Z'),
  };

  it('reads the saved signature and initials', async () => {
    await provider
      .addInteraction()
      .given('a sign-mobile user has a saved signature')
      .uponReceiving('a native saved signature read')
      .withRequest('GET', '/v1/sign/me/signature', (b) => {
        b.headers(AUTH);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ signature: savedView, initials: null });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/me/signature`, { headers: AUTH });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { signature: { kind: string } }).signature.kind).toBe('TYPED');
      });
  });

  it('saves the default signature (PNG data URL)', async () => {
    await provider
      .addInteraction()
      .given('an esign sender session exists')
      .uponReceiving('a native saved signature update')
      .withRequest('PUT', '/v1/sign/me/signature', (b) => {
        b.headers(JSON_AUTH).jsonBody(typed);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(savedView);
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/me/signature`, { method: 'PUT', headers: JSON_AUTH, body: JSON.stringify(typed) });
        expect(res.status).toBe(200);
      });
  });
});

describe('sign-mobile → POST /v1/sign/sender/contacts (M-A3 §5)', () => {
  it('saves a private contact', async () => {
    const body = { name: 'Rita Recipient', email: 'rita.mobile@example.com', organization: 'Rita Co' };
    await provider
      .addInteraction()
      .given('an esign sender session exists')
      .uponReceiving('a native contact create')
      .withRequest('POST', '/v1/sign/sender/contacts', (b) => {
        b.headers(JSON_AUTH).jsonBody(body);
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({
          id: uuid('e6000000-0000-7000-8000-000000000021'),
          name: 'Rita Recipient',
          email: 'rita.mobile@example.com',
          organization: 'Rita Co',
          source: 'saved',
          created_at: iso('2026-10-25T10:00:00.000Z'),
          updated_at: iso('2026-10-25T10:00:00.000Z'),
          last_used_at: null,
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/sender/contacts`, { method: 'POST', headers: JSON_AUTH, body: JSON.stringify(body) });
        expect(res.status).toBe(201);
      });
  });
});

describe('sign-mobile → envelope detail, If-Match writes and delete (M-A3 §6, D-W6-3)', () => {
  it('reads the envelope detail with its ETag "{id}.{revision}" and page sizes', async () => {
    await provider
      .addInteraction()
      .given('a sender-authored envelope exists', { envelope_id: DETAIL_ENVELOPE_ID })
      .uponReceiving('a native envelope detail read')
      .withRequest('GET', `/v1/sign/sender/envelopes/${DETAIL_ENVELOPE_ID}`, (b) => {
        b.headers(AUTH);
      })
      .willRespondWith(200, (b) => {
        b.headers({ ETag: etagOf(DETAIL_ENVELOPE_ID, 5) }).jsonBody({
          id: DETAIL_ENVELOPE_ID,
          status: 'DRAFT',
          editable: true,
          revision: integer(5),
          message: null,
          signing_link_valid_days: 7,
          envelope_expires_at: null,
          routing_mode: regex('^(PARALLEL|SEQUENTIAL)$', 'PARALLEL'),
          documents: eachLike({
            id: uuid('e6000000-0000-7000-8000-0000000000a2'),
            title: like('Offer letter'),
            page_count: integer(1),
            pages: eachLike({ width: like(612), height: like(792) }),
          }),
          recipients: eachLike({
            id: uuid('e6000000-0000-7000-8000-0000000000a3'),
            name: like('Jane Doe'),
            email: like('jane@example.com'),
            status: regex('^(PENDING|VIEWED|SIGNED|DECLINED)$', 'PENDING'),
            signing_order: integer(1),
            can_remind: boolean(false),
            reminder_available_at: null,
          }),
          fields: eachLike({
            id: uuid('e6000000-0000-7000-8000-0000000000a4'),
            field_type: 'SIGNATURE',
            page_number: integer(0),
            x: like(72),
            y: like(100),
            width: like(180),
            height: like(40),
          }),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/sender/envelopes/${DETAIL_ENVELOPE_ID}`, { headers: AUTH });
        expect(res.status).toBe(200);
        expect(res.headers.get('etag')).toMatch(new RegExp(`^"${DETAIL_ENVELOPE_ID}\\.\\d+"$`));
      });
  });

  it('sets the sender message with If-Match and answers with the next ETag', async () => {
    const ifMatch = `"${PATCH_ENVELOPE_ID}.${DRAFT_REVISION}"`;
    await provider
      .addInteraction()
      .given('a sender draft envelope exists', { envelope_id: PATCH_ENVELOPE_ID })
      .uponReceiving('a native draft message update with If-Match')
      .withRequest('PATCH', `/v1/sign/sender/envelopes/${PATCH_ENVELOPE_ID}`, (b) => {
        b.headers({ ...JSON_AUTH, 'If-Match': ifMatch }).jsonBody({ message: 'Please sign by Friday' });
      })
      .willRespondWith(200, (b) => {
        b.headers({ ETag: etagOf(PATCH_ENVELOPE_ID, 3) }).jsonBody({ id: PATCH_ENVELOPE_ID, status: 'DRAFT', revision: integer(3), message: 'Please sign by Friday' });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/sender/envelopes/${PATCH_ENVELOPE_ID}`, {
          method: 'PATCH',
          headers: { ...JSON_AUTH, 'If-Match': ifMatch },
          body: JSON.stringify({ message: 'Please sign by Friday' }),
        });
        expect(res.status).toBe(200);
      });
  });

  it('a reminder inside the 60-minute cooldown is refused 429 with when to retry', async () => {
    await provider
      .addInteraction()
      .given('a sent sender envelope whose signer was just reminded', { envelope_id: REMIND_ENVELOPE_ID })
      .uponReceiving('a native reminder inside the cooldown')
      .withRequest('POST', `/v1/sign/sender/envelopes/${REMIND_ENVELOPE_ID}/remind`, (b) => {
        b.headers(JSON_AUTH).jsonBody({ signer_id: REMIND_SIGNER_ID });
      })
      .willRespondWith(429, (b) => {
        b.jsonBody(
          errorBody('ESIGN_REMINDER_NOT_ALLOWED', {
            reason: 'reminder_cooldown',
            retry_after_seconds: integer(3599),
            retry_at: iso('2026-10-25T11:00:00.000Z'),
          }),
        );
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/sender/envelopes/${REMIND_ENVELOPE_ID}/remind`, {
          method: 'POST',
          headers: JSON_AUTH,
          body: JSON.stringify({ signer_id: REMIND_SIGNER_ID }),
        });
        expect(res.status).toBe(429);
        expect(((await res.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe('reminder_cooldown');
      });
  });

  it('deletes a draft with If-Match (204)', async () => {
    const ifMatch = `"${DELETE_ENVELOPE_ID}.${DRAFT_REVISION}"`;
    await provider
      .addInteraction()
      .given('a sender draft envelope exists', { envelope_id: DELETE_ENVELOPE_ID })
      .uponReceiving('a native draft delete with If-Match')
      .withRequest('DELETE', `/v1/sign/sender/envelopes/${DELETE_ENVELOPE_ID}`, (b) => {
        b.headers({ ...AUTH, 'If-Match': ifMatch });
      })
      .willRespondWith(204)
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/sender/envelopes/${DELETE_ENVELOPE_ID}`, { method: 'DELETE', headers: { ...AUTH, 'If-Match': ifMatch } });
        expect(res.status).toBe(204);
      });
  });
});

describe('sign-mobile → GET /v1/sign/inbox (Sign Unified Product S-7)', () => {
  it('lists the documents waiting for the signed-in user (recipient facts only)', async () => {
    await provider
      .addInteraction()
      .given('a sign-mobile user has a document waiting in the inbox')
      .uponReceiving('a native inbox read')
      .withRequest('GET', '/v1/sign/inbox', (b) => {
        b.headers(AUTH);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          waiting: eachLike({
            id: uuid(INBOX_BINDING_ID),
            subject: like('Contractor agreement'),
            envelope_status: regex('^(SENT|IN_PROGRESS)$', 'SENT'),
            my_status: regex('^(PENDING|VIEWED)$', 'PENDING'),
            sent_at: iso('2026-10-25T10:00:00.000Z'),
            signing_link_valid_days: 7,
            can_sign: true,
            can_download: false,
          }),
          completed: [],
          other: [],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/inbox`, { headers: AUTH });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { waiting: unknown[] };
        expect(body.waiting.length).toBeGreaterThan(0);
      });
  });
});
