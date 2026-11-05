import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';

const { like, uuid, integer, boolean, eachLike, regex, fromProviderState } = MatchersV3;

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
//  14. PUT    /v1/sign/sender/envelopes/{id}/fields (If-Match) 200 — M-A6 Name + Checkbox configuration
// W2 Inbox Discovery (LOCKED Gate-5 plan A3.1-A3.5, A4 Pact row):
//  15. GET    /v1/sign/inbox                            200 a discovered item (opaque handle id)
//  16. GET    /v1/sign/inbox                            200 an upcoming item (my_status upcoming)
//  17. POST   /v1/sign/inbox/{handle}/sign              200 { signing_url, expires_at }
//  18. POST   /v1/sign/inbox/{handle}/sign (stale)      404 inbox_item_not_found
//  19. GET    /v1/sign/sender/envelopes                 200 items carry awaiting_you
//  20. GET    /v1/sign/sender/envelopes                 200 awaiting_you + my_inbox_item_id (handle)
// M-A12 (agent A): self create, sender/signer text layer, profile GET/PUT, settings GET/PUT,
//   app-issues 202, template favorite PUT/DELETE 204 (see the M-A12 describe at the end).

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
// W2 — each recipient-side state signs in its OWN user (pact/provider/src/verify-sign.ts).
const DISCOVERED_AUTH = { Authorization: 'Bearer pact-native-sign-access-token-discovered', 'X-Aramo-Consumer': 'sign' };
const UPCOMING_AUTH = { Authorization: 'Bearer pact-native-sign-access-token-upcoming', 'X-Aramo-Consumer': 'sign' };
// A discovered item's id is an opaque base64url handle (never a uuid); the example is shape only.
const HANDLE = '^[A-Za-z0-9_-]{40,}$';
const EXAMPLE_HANDLE = 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8w';
const AWAITING_ENVELOPE_ID = 'e6b20000-0000-7000-8000-0000000000a1';
// State 5 — Ava's only envelope waits for her own discovered step; her own placeholder.
const AWAITING_ITEM_ENVELOPE_ID = 'e6b20000-0000-7000-8000-0000000000d1';
const AWAITING_AUTH = { Authorization: 'Bearer pact-native-sign-access-token-awaiting', 'X-Aramo-Consumer': 'sign' };
// M-A6 §2 — a draft with a document and a recipient for the Name/Checkbox fields
// replace (envelope, document, recipient and ledger event: revision 4).
const FIELDS_ENVELOPE_ID = 'e6000000-0000-7000-8000-000000000101';
const FIELDS_REVISION = 4;
const childOf = (envelopeId: string, n: number): string => `${envelopeId.slice(0, -1)}${String(n)}`;
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
            source: 'bound',
            i_am_sender: boolean(false),
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

// W2 (A3.1, A3.2) — discovered items render like bound ones; an upcoming item never signs.
describe('sign-mobile → GET /v1/sign/inbox (W2 discovery)', () => {
  it('lists a document sent to the verified account email as a discovered item', async () => {
    await provider
      .addInteraction()
      .given('a sign user has a discovered document waiting in the inbox')
      .uponReceiving('a native inbox read with a discovered item')
      .withRequest('GET', '/v1/sign/inbox', (b) => {
        b.headers(DISCOVERED_AUTH);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          waiting: eachLike({
            id: regex(HANDLE, EXAMPLE_HANDLE),
            source: 'discovered',
            i_am_sender: boolean(false),
            subject: like('Discovered agreement'),
            envelope_status: 'SENT',
            my_status: 'PENDING',
            sent_at: iso('2026-11-03T10:00:00.000Z'),
            can_sign: true,
            can_download: false,
          }),
          completed: [],
          other: [],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/inbox`, { headers: DISCOVERED_AUTH });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { waiting: { id: string; source: string }[] };
        expect(body.waiting[0]?.source).toBe('discovered');
      });
  });

  it('lists a later-turn document as upcoming (can_sign false)', async () => {
    await provider
      .addInteraction()
      .given('a sign user has an upcoming document in the inbox')
      .uponReceiving('a native inbox read with an upcoming item')
      .withRequest('GET', '/v1/sign/inbox', (b) => {
        b.headers(UPCOMING_AUTH);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          waiting: eachLike({
            id: like(EXAMPLE_HANDLE),
            source: 'discovered',
            i_am_sender: boolean(false),
            subject: like('Sequential agreement'),
            envelope_status: 'SENT',
            my_status: 'upcoming',
            can_sign: false,
            can_download: false,
          }),
          completed: [],
          other: [],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/inbox`, { headers: UPCOMING_AUTH });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { waiting: { my_status: string; can_sign: boolean }[] };
        expect(body.waiting[0]).toMatchObject({ my_status: 'upcoming', can_sign: false });
      });
  });
});

// W2 (A3.3, A3.4) — signing a discovered item by its handle mints the same session shape.
describe('sign-mobile → POST /v1/sign/inbox/{handle}/sign (W2 discovery)', () => {
  it('mints an inbox signing session from a discovered item handle', async () => {
    await provider
      .addInteraction()
      .given('a sign user has a discovered document to sign')
      .uponReceiving('a native inbox sign from a discovered item handle')
      .withRequest('POST', fromProviderState('/v1/sign/inbox/${inbox_handle}/sign', `/v1/sign/inbox/${EXAMPLE_HANDLE}/sign`), (b) => {
        b.headers(DISCOVERED_AUTH);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          signing_url: regex('^https://[^/]+/s/[A-Za-z0-9_-]{32,256}$', 'https://sign.aramo.ai/s/abcdefghijklmnopqrstuvwxyz0123456789'),
          expires_at: iso('2026-11-03T10:30:00.000Z'),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/inbox/${EXAMPLE_HANDLE}/sign`, { method: 'POST', headers: DISCOVERED_AUTH });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { signing_url: string };
        expect(body.signing_url).toMatch(/\/s\//);
      });
  });

  it('refuses a stale or foreign handle with 404 inbox_item_not_found', async () => {
    await provider
      .addInteraction()
      .given('a sign user has a discovered document waiting in the inbox')
      .uponReceiving('a native inbox sign from a stale item handle')
      .withRequest('POST', '/v1/sign/inbox/not-a-real-handle/sign', (b) => {
        b.headers(DISCOVERED_AUTH);
      })
      .willRespondWith(404, (b) => {
        b.jsonBody({ error: { code: like('NOT_FOUND'), message: like('message'), request_id: like('req-1'), details: { reason: 'inbox_item_not_found' } } });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/inbox/not-a-real-handle/sign`, { method: 'POST', headers: DISCOVERED_AUTH });
        expect(res.status).toBe(404);
        const body = (await res.json()) as { error: { details: { reason: string } } };
        expect(body.error.details.reason).toBe('inbox_item_not_found');
      });
  });
});

// W2 (A3.5) — the sender list says when only the signed-in sender's own signature remains.
describe('sign-mobile → GET /v1/sign/sender/envelopes (W2 awaiting_you)', () => {
  it('marks an envelope waiting only for the signed-in sender', async () => {
    await provider
      .addInteraction()
      .given('a sender envelope is awaiting the signed-in sender')
      .uponReceiving('a native sender list read with awaiting_you')
      .withRequest('GET', '/v1/sign/sender/envelopes', (b) => {
        b.headers(AUTH);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          items: eachLike({
            id: uuid(AWAITING_ENVELOPE_ID),
            subject: like('Self-sent agreement'),
            status: regex('^(DRAFT|SENT|IN_PROGRESS|COMPLETED|DECLINED|VOIDED|EXPIRED)$', 'SENT'),
            created_at: iso('2026-11-03T10:00:00.000Z'),
            document_count: integer(1),
            awaiting_you: boolean(true),
          }),
          counts: like({ SENT: 1 }),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/sender/envelopes`, { headers: AUTH });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: { awaiting_you: boolean }[] };
        expect(typeof body.items[0]?.awaiting_you).toBe('boolean');
      });
  });
});

describe('sign-mobile → GET /v1/sign/sender/envelopes (W2 my_inbox_item_id)', () => {
  it('names the signed-in sender’s own inbox item for an envelope waiting for them', async () => {
    await provider
      .addInteraction()
      .given('a sender envelope is awaiting the signed-in sender with an inbox item')
      .uponReceiving('a native sender list read with my_inbox_item_id')
      .withRequest('GET', '/v1/sign/sender/envelopes', (b) => {
        b.headers(AWAITING_AUTH);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          items: eachLike({
            id: uuid(AWAITING_ITEM_ENVELOPE_ID),
            subject: like('Self-sent agreement'),
            status: 'SENT',
            created_at: iso('2026-11-03T10:00:00.000Z'),
            document_count: integer(1),
            awaiting_you: true,
            my_inbox_item_id: regex(HANDLE, EXAMPLE_HANDLE),
          }),
          counts: like({ SENT: 1 }),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/sender/envelopes`, { headers: AWAITING_AUTH });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: { awaiting_you: boolean; my_inbox_item_id: string | null }[] };
        expect(body.items[0]?.awaiting_you).toBe(true);
        expect(typeof body.items[0]?.my_inbox_item_id).toBe('string');
      });
  });
});

// M-A6 §2 — the native editor's Name and Checkbox tools: configuration only, never a value.
describe('sign-mobile → PUT /v1/sign/sender/envelopes/{id}/fields (M-A6 Name and Checkbox)', () => {
  it('replaces the draft fields with a profile name and a labelled check box', async () => {
    const ifMatch = `"${FIELDS_ENVELOPE_ID}.${FIELDS_REVISION}"`;
    const base = { envelope_document_id: childOf(FIELDS_ENVELOPE_ID, 2), signer_id: childOf(FIELDS_ENVELOPE_ID, 3), page_number: 0, x: 72, required: true };
    const body = {
      fields: [
        { ...base, field_type: 'SIGNER_NAME', y: 100, width: 200, height: 22, name_mode: 'SIGNER_PROFILE' },
        { ...base, field_type: 'CHECKBOX', y: 140, width: 14, height: 14, label: 'I agree to the terms' },
      ],
    };
    await provider
      .addInteraction()
      .given('a sender draft envelope with a document and a recipient exists', { envelope_id: FIELDS_ENVELOPE_ID })
      .uponReceiving('a native Name and Checkbox fields replace with If-Match')
      .withRequest('PUT', `/v1/sign/sender/envelopes/${FIELDS_ENVELOPE_ID}/fields`, (b) => {
        b.headers({ ...JSON_AUTH, 'If-Match': ifMatch }).jsonBody(body);
      })
      .willRespondWith(200, (b) => {
        b.headers({ ETag: etagOf(FIELDS_ENVELOPE_ID, FIELDS_REVISION + 1) }).jsonBody({
          id: FIELDS_ENVELOPE_ID,
          status: 'DRAFT',
          revision: integer(FIELDS_REVISION + 1),
          fields: eachLike({
            id: uuid(childOf(FIELDS_ENVELOPE_ID, 4)),
            field_type: regex('^(SIGNER_NAME|CHECKBOX)$', 'SIGNER_NAME'),
            required: true,
          }, 2),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/sender/envelopes/${FIELDS_ENVELOPE_ID}/fields`, {
          method: 'PUT',
          headers: { ...JSON_AUTH, 'If-Match': ifMatch },
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(200);
        const out = (await res.json()) as { fields: unknown[] };
        expect(out.fields).toHaveLength(2);
      });
  });
});

// Aramo Sign Mobile M-A12 W1-G — plans, account and in-app store billing. The provider verifies with
// store billing DARK (SIGN_STORE_BILLING_ENABLED unset): no store product is offered, the account says
// why the app may not buy, and every store route answers 503 store_billing_disabled. The plans are
// filtered to the caller's tenant kind (R-2, A5).
describe('sign-mobile → billing and store (M-A12 W1-G)', () => {
  it('reads the plans of the caller’s tenant kind, with store products and the regional price', async () => {
    await provider
      .addInteraction()
      .given('an esign sender session exists')
      .uponReceiving('a native plans read (store billing off)')
      .withRequest('GET', '/v1/sign/billing/plans', (b) => {
        b.headers(AUTH);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          plans: eachLike({ key: like('aramo-sign-standard-business-v1'), name: like('Business'), purchasable: boolean(false), store_products: [], regional_price: null, regional_prices: [] }),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/billing/plans`, { headers: AUTH });
        expect(res.status).toBe(200);
        const out = (await res.json()) as { plans: { store_products: unknown[] }[] };
        expect(out.plans[0]?.store_products).toEqual([]);
      });
  });

  it('reads the account: where the plan is managed and whether the app may buy', async () => {
    await provider
      .addInteraction()
      .given('an esign sender session exists')
      .uponReceiving('a native billing account read (store billing off)')
      .withRequest('GET', '/v1/sign/billing/account', (b) => {
        b.headers(AUTH);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          tenant_kind: like('BUSINESS'),
          can_manage_billing: boolean(true),
          managed_by: null,
          store_purchase_eligible: false,
          store_purchase_block_reason: 'store_billing_disabled',
          manage_url: null,
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/billing/account`, { headers: AUTH });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { store_purchase_eligible: boolean }).store_purchase_eligible).toBe(false);
      });
  });

  it('a store purchase intent is refused while store billing is off', async () => {
    const body = { platform: 'ios', product_id: 'ai.aramo.sign.business.monthly' };
    await provider
      .addInteraction()
      .given('an esign sender session exists')
      .uponReceiving('a native store purchase intent while store billing is off')
      .withRequest('POST', '/v1/sign/billing/store/intent', (b) => {
        b.headers(JSON_AUTH).jsonBody(body);
      })
      .willRespondWith(503, (b) => {
        b.jsonBody(errorBody('ESIGN_BILLING_UNAVAILABLE', { reason: 'store_billing_disabled' }));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/billing/store/intent`, { method: 'POST', headers: JSON_AUTH, body: JSON.stringify(body) });
        expect(res.status).toBe(503);
      });
  });

  it('a store purchase verification is refused while store billing is off', async () => {
    const body = { platform: 'android', product_id: 'ai.aramo.sign.business.monthly', intent_id: 'e6120000-0000-7000-8000-000000000001', purchase_token: 'pact-play-purchase-token' };
    await provider
      .addInteraction()
      .given('an esign sender session exists')
      .uponReceiving('a native store purchase verification while store billing is off')
      .withRequest('POST', '/v1/sign/billing/store/verify', (b) => {
        b.headers(JSON_AUTH).jsonBody(body);
      })
      .willRespondWith(503, (b) => {
        b.jsonBody(errorBody('ESIGN_BILLING_UNAVAILABLE', { reason: 'store_billing_disabled' }));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/billing/store/verify`, { method: 'POST', headers: JSON_AUTH, body: JSON.stringify(body) });
        expect(res.status).toBe(503);
      });
  });

  it('a store restore is refused while store billing is off', async () => {
    const body = { platform: 'android', purchase_tokens: ['pact-play-purchase-token'] };
    await provider
      .addInteraction()
      .given('an esign sender session exists')
      .uponReceiving('a native store restore while store billing is off')
      .withRequest('POST', '/v1/sign/billing/store/restore', (b) => {
        b.headers(JSON_AUTH).jsonBody(body);
      })
      .willRespondWith(503, (b) => {
        b.jsonBody(errorBody('ESIGN_BILLING_UNAVAILABLE', { reason: 'store_billing_disabled' }));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/billing/store/restore`, { method: 'POST', headers: JSON_AUTH, body: JSON.stringify(body) });
        expect(res.status).toBe(503);
      });
  });
});

// Aramo-Sign-Mobile-Amendment-M-A12 (LOCKED) W1-A / W1-C.2 / W1-E / W1-F — self-sign create, Find in
// document (sender GET, signer POST), the Sign profile and settings, app issues, template favorites.
// The fixed ids and the self token MUST match pact/provider/src/verify-sign.ts.
const SELF_ENVELOPE_ID = 'e6c10000-0000-7000-8000-0000000000a1';
const SELF_SESSION_ENVELOPE_ID = 'e6c10000-0000-7000-8000-0000000000b1';
const SELF_TOKEN = 'sign-mobile-pact-token-self';
const TEMPLATE_ID = 'e6c10000-0000-7000-8000-000000000001';
const PROFILE_BODY = { display_name: 'Sam Sender', title: 'Account Manager', company: 'Pact Sign Co', country: 'US', phone: '+14155550123' };

describe('sign-mobile → M-A12 self-sign, text layer, profile, settings, app issues, favorites', () => {
  it('creates a self-sign draft (mode self)', async () => {
    await provider
      .addInteraction()
      .given('an esign sender session exists')
      .uponReceiving('a native self-sign draft create')
      .withRequest('POST', '/v1/sign/sender/envelopes', (b) => {
        b.headers(JSON_AUTH).jsonBody({ mode: 'self', subject: 'My lease' });
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({ id: uuid('e6c10000-0000-7000-8000-0000000000f1'), status: 'DRAFT', subject: 'My lease', mode: 'self' });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/sender/envelopes`, { method: 'POST', headers: JSON_AUTH, body: JSON.stringify({ mode: 'self', subject: 'My lease' }) });
        expect(res.status).toBe(201);
        expect(((await res.json()) as { mode: string }).mode).toBe('self');
      });
  });

  it('reads a document text layer as the sender (an image-only page has no words)', async () => {
    const doc = childOf(SELF_ENVELOPE_ID, 2);
    const path = `/v1/sign/sender/envelopes/${SELF_ENVELOPE_ID}/documents/${doc}/text-layer`;
    await provider
      .addInteraction()
      .given('a sent self-sign envelope awaits the signed-in sender', { envelope_id: SELF_ENVELOPE_ID })
      .uponReceiving('a native sender text-layer read')
      .withRequest('GET', path, (b) => {
        b.headers(AUTH);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ document_id: doc, pages: eachLike({ page: integer(1), words: [] }) });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${path}`, { headers: AUTH });
        expect(res.status).toBe(200);
        const out = (await res.json()) as { pages: { page: number; words: unknown[] }[] };
        expect(out.pages[0]?.page).toBe(1);
      });
  });

  it('reads a document text layer through the SELF signing session (token in the body)', async () => {
    const doc = childOf(SELF_SESSION_ENVELOPE_ID, 2);
    const path = `/v1/sign/signing/documents/${doc}/text-layer`;
    await provider
      .addInteraction()
      .given('a self-sign session has accepted the disclosure', { envelope_id: SELF_SESSION_ENVELOPE_ID })
      .uponReceiving('a signer text-layer read with the session token')
      .withRequest('POST', path, (b) => {
        b.headers({ 'Content-Type': 'application/json' }).jsonBody({ token: SELF_TOKEN });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ document_id: doc, pages: eachLike({ page: integer(1), words: [] }) });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: SELF_TOKEN }) });
        expect(res.status).toBe(200);
      });
  });

  it('reads the Sign profile', async () => {
    await provider
      .addInteraction()
      .given('a sign-mobile user has a Sign profile')
      .uponReceiving('a native Sign profile read')
      .withRequest('GET', '/v1/sign/me/profile', (b) => {
        b.headers(AUTH);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          display_name: like('Sam Sender'),
          title: like('Account Manager'),
          company: like('Pact Sign Co'),
          country: like('US'),
          phone: like('+14155550123'),
          email: like('sam.sender@example.com'),
          updated_at: like('2026-11-04T00:00:00.000Z'),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/me/profile`, { headers: AUTH });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { display_name: string }).display_name).toBe('Sam Sender');
      });
  });

  it('saves the Sign profile', async () => {
    await provider
      .addInteraction()
      .given('an esign sender session exists')
      .uponReceiving('a native Sign profile save')
      .withRequest('PUT', '/v1/sign/me/profile', (b) => {
        b.headers(JSON_AUTH).jsonBody(PROFILE_BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ ...PROFILE_BODY, address_line1: null, city: null, email: like('sam.sender@example.com'), updated_at: like('2026-11-04T00:00:00.000Z') });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/me/profile`, { method: 'PUT', headers: JSON_AUTH, body: JSON.stringify(PROFILE_BODY) });
        expect(res.status).toBe(200);
      });
  });

  it('reads the Sign settings', async () => {
    await provider
      .addInteraction()
      .given('a sign-mobile user has a Sign profile')
      .uponReceiving('a native Sign settings read')
      .withRequest('GET', '/v1/sign/me/settings', (b) => {
        b.headers(AUTH);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ date_format: regex('^(MM/DD/YYYY|DD/MM/YYYY|YYYY-MM-DD)$', 'DD/MM/YYYY'), default_field_size: regex('^(S|M|L)$', 'M') });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/me/settings`, { headers: AUTH });
        expect(res.status).toBe(200);
      });
  });

  it('saves the Sign settings', async () => {
    const body = { date_format: 'YYYY-MM-DD', default_field_size: 'L' };
    await provider
      .addInteraction()
      .given('an esign sender session exists')
      .uponReceiving('a native Sign settings save')
      .withRequest('PUT', '/v1/sign/me/settings', (b) => {
        b.headers(JSON_AUTH).jsonBody(body);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(body);
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/me/settings`, { method: 'PUT', headers: JSON_AUTH, body: JSON.stringify(body) });
        expect(res.status).toBe(200);
      });
  });

  it('reports an app issue (202)', async () => {
    const body = { message: 'The Find button does nothing', app_version: '1.2.0', os: 'android', os_version: '15', device_model: 'Pixel 8', screen: 'Signing' };
    await provider
      .addInteraction()
      .given('app issue reports are delivered to support')
      .uponReceiving('a native app issue report')
      .withRequest('POST', '/v1/sign/me/app-issues', (b) => {
        b.headers(JSON_AUTH).jsonBody(body);
      })
      .willRespondWith(202, (b) => {
        b.jsonBody({ received: true, reference: uuid('e6c10000-0000-7000-8000-0000000000e1') });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/me/app-issues`, { method: 'POST', headers: JSON_AUTH, body: JSON.stringify(body) });
        expect(res.status).toBe(202);
      });
  });

  it('marks a template as a favorite (204)', async () => {
    await provider
      .addInteraction()
      .given('an esign sender session exists')
      .uponReceiving('a native template favorite')
      .withRequest('PUT', `/v1/sign/sender/templates/${TEMPLATE_ID}/favorite`, (b) => {
        b.headers(AUTH);
      })
      .willRespondWith(204)
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/sender/templates/${TEMPLATE_ID}/favorite`, { method: 'PUT', headers: AUTH });
        expect(res.status).toBe(204);
      });
  });

  it('removes a template favorite (204)', async () => {
    await provider
      .addInteraction()
      .given('a sign-mobile user has a favorite template')
      .uponReceiving('a native template unfavorite')
      .withRequest('DELETE', `/v1/sign/sender/templates/${TEMPLATE_ID}/favorite`, (b) => {
        b.headers(AUTH);
      })
      .willRespondWith(204)
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/sender/templates/${TEMPLATE_ID}/favorite`, { method: 'DELETE', headers: AUTH });
        expect(res.status).toBe(204);
      });
  });
});
