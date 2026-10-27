import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { like, uuid, integer, eachLike, regex } = MatchersV3;

// PX-1 (PX-V1 §12) — the authenticated SENDER-console transport contract.
//
// Consumer:  esign-web       (apps/esign-web/src/api.ts `senderApi` — the Aramo
//                             Sign sender console at esign.aramo.ai; tenant, user
//                             and authority are resolved server-side from the
//                             `sign` session, never sent).
// Provider:  sign-service   (apps/sign-service, EsignSenderController at
//                             `v1/sign/sender`).
//
// Mirrors the EXACT request shapes senderApi issues through the fe-foundation
// ApiClient (method / path / JSON body, `X-Aramo-Consumer: sign`, and the
// browser-attached consumer-isolated session cookie `aramo_access_token_sign`).
// Per the established harness convention (sign-web-consumer, sign-consumer,
// ats-web) the interactions are issued as raw fetches matching the client: the
// production client is an apps/esign-web module using relative paths and a
// browser cookie jar, and an app module is not import-invokable from a pact
// project without crossing the nx project boundary.
//
// The session cookie value is a PLACEHOLDER; the provider verifier rewrites it
// to a real RS256 `sign` access token for the seeded sender (verify-sign.ts
// requestFilter). The 401 interaction carries no cookie and is left untouched.
//
// Each mutating op targets its OWN envelope id so the provider seeds an
// INDEPENDENT fixture per interaction — SignatureEvent is append-only (no
// delete), so shared-envelope re-seeding is impossible.
//
// Coverage (api.ts senderApi):
//   1. GET  /v1/sign/sender/context                         200 SenderContext
//   2. GET  /v1/sign/sender/envelopes                       200 { items, counts }
//   3. POST /v1/sign/sender/envelopes                       201 { id, status, subject }
//   4. POST /v1/sign/sender/envelopes/{id}/documents        201 UploadedDocument
//   5. PUT  /v1/sign/sender/envelopes/{id}/recipients       200 EnvelopeDetail
//   6. PUT  /v1/sign/sender/envelopes/{id}/fields           200 EnvelopeDetail
//   7. POST /v1/sign/sender/envelopes/{id}/send             200 EnvelopeDetail (SENT)
//   8. POST /v1/sign/sender/envelopes/{id}/void             200 EnvelopeDetail (VOIDED)
//   9. GET  /v1/sign/sender/envelopes (no session)          401 AUTH_REQUIRED
//  10. POST /v1/sign/billing/checkout (governed subscription) 409 ESIGN_BILLING_CONFLICT
//      details.reason governed_subscription_open (CCP-A6, Conversion Rule C-1 / C-4: the
//      Settings → Plan & billing checkout of apps/sign-web/src/workspace/api.ts)
//  11. GET  /v1/sign/billing/account (held activation)      200 pending_activation (CCP-A6-R, C-8)
//  12. GET  /v1/sign/billing/self-service                   200 every action unavailable,
//      reason SELF_SERVICE_TERMS_NOT_APPROVED (CCP-C7: the designed disabled state, PBD §10;
//      billingApi.selfService of apps/sign-web/src/workspace/api.ts)
//  13. POST /v1/sign/billing/self-service/cancel            503 ESIGN_BILLING_UNAVAILABLE
//      details.reason self_service_terms_not_approved (CCP-C7; billingApi.selfServiceCancel)
// Aramo Sign Mobile (M-A3 §3/§5/§6) — the same contracts serve web and mobile:
//  14. GET   /v1/sign/sender/envelopes/{id}                 200 EnvelopeDetail + ETag "{id}.{revision}"
//  15. PATCH /v1/sign/sender/envelopes/{id} (If-Match)      200 sets the sender message
//  16. PATCH /v1/sign/sender/envelopes/{id} (stale If-Match) 412 revision_mismatch
//  17. POST  /v1/sign/sender/contacts                       201 SenderContact
// Privacy Notice 1.1 remediation E-6 — the in-service notice of an upcoming legal version:
// Aramo-Sign-Unified-Product-Amendment-M-A5 §1 / §2 / §7:
//  19. PUT   /v1/sign/sender/envelopes/{id}/recipients (a signer + a copy recipient with its timing)
//  18. GET   /v1/sign/legal/notices                         200 { notices: [] } (nothing announced:
//      the shipped upcoming-change list is empty; legalApi.notices of apps/sign-web/src/workspace/api.ts)

const provider = new PactV4({
  consumer: 'sign-workspace',
  provider: 'sign-service',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

// Fixed values — MUST match the per-op seeds in pact/provider/src/verify-sign.ts.
const BASE = '/v1/sign/sender';
const SESSION_COOKIE = 'aramo_access_token_sign=esign-web-pact-session';
const AUTH_HEADERS = { 'X-Aramo-Consumer': 'sign', Cookie: SESSION_COOKIE };
const JSON_HEADERS = { ...AUTH_HEADERS, 'Content-Type': 'application/json' };

const TENANT_ID = 'e5000000-0000-7000-8000-000000000001';
const USER_ID = 'e5000000-0000-7000-8000-000000000002';
// list
const LIST_ENVELOPE_ID = 'e5000000-0000-7000-8000-0000000000a1';
// upload
const UPLOAD_ENVELOPE_ID = 'e5000000-0000-7000-8000-0000000000b1';
// recipients
const RECIPIENTS_ENVELOPE_ID = 'e5000000-0000-7000-8000-0000000000c1';
// fields (document + recipient)
const FIELDS_ENVELOPE_ID = 'e5000000-0000-7000-8000-0000000000d1';
const FIELDS_DOC_ID = 'e5000000-0000-7000-8000-0000000000d2';
const FIELDS_SIGNER_ID = 'e5000000-0000-7000-8000-0000000000d3';
// send (document + recipient + SIGNATURE field)
const SEND_ENVELOPE_ID = 'e5000000-0000-7000-8000-0000000000e1';
// void (SENT)
const VOID_ENVELOPE_ID = 'e5000000-0000-7000-8000-0000000000f1';
// Sign Mobile — detail + ETag, message with If-Match, stale If-Match. Each a fresh
// fixture: a seeded DRAFT (envelope row + one ledger event) is at revision 2, the
// sender-authored fixture (envelope, document, recipient, field, event) at revision 5.
const ETAG_ENVELOPE_ID = 'e5000000-0000-7000-8000-000000000101';
const MESSAGE_ENVELOPE_ID = 'e5000000-0000-7000-8000-000000000111';
const STALE_ENVELOPE_ID = 'e5000000-0000-7000-8000-000000000121';

const ISO = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$';
const iso = (example: string) => regex(ISO, example);
const STATUS = '^(DRAFT|SENT|IN_PROGRESS|COMPLETED|DECLINED|VOIDED|EXPIRED)$';

// A minimal, deterministic single-page US-Letter (612x792 pt) PDF.
async function letterPdfBase64(): Promise<string> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.addPage([612, 792]);
  const bytes = await pdf.save({ useObjectStreams: false });
  return Buffer.from(bytes).toString('base64');
}

// The EnvelopeDetail body (api.ts EnvelopeDetail), with the status pinned.
function detailBody(envelopeId: string, status: string, opts: { documents?: boolean; recipients?: boolean; fields?: boolean; sentAt?: boolean; voidedAt?: boolean }) {
  const doc = {
    id: uuid('e5000000-0000-7000-8000-0000000000d2'),
    title: like('Offer letter'),
    ordinal: integer(1),
    content_type: like('application/pdf'),
    byte_size: integer(1024),
    source_sha256: regex('^[0-9a-f]{64}$', 'a'.repeat(64)),
    field_count: integer(1),
  };
  const recipient = {
    id: uuid('e5000000-0000-7000-8000-0000000000d3'),
    name: like('Jane Doe'),
    email: like('jane@example.com'),
    status: regex('^(PENDING|VIEWED|SIGNED|DECLINED)$', 'PENDING'),
    signing_order: integer(1),
    viewed_at: null,
    signed_at: null,
    declined_at: null,
    decline_reason: null,
  };
  const field = {
    id: uuid('e5000000-0000-7000-8000-0000000000d4'),
    envelope_document_id: uuid('e5000000-0000-7000-8000-0000000000d2'),
    signer_id: uuid('e5000000-0000-7000-8000-0000000000d3'),
    field_type: 'SIGNATURE',
    page_number: integer(0),
    x: like(72),
    y: like(100),
    width: like(180),
    height: like(40),
    required: like(true),
    filled: like(false),
  };
  return {
    id: envelopeId,
    subject: like('Offer letter'),
    status,
    created_at: iso('2026-10-18T10:00:00.000Z'),
    sent_at: opts.sentAt === true ? iso('2026-10-18T10:05:00.000Z') : null,
    completed_at: null,
    declined_at: null,
    voided_at: opts.voidedAt === true ? iso('2026-10-18T10:10:00.000Z') : null,
    expires_at: opts.sentAt === true ? iso('2026-10-25T10:05:00.000Z') : null,
    signing_window_days: integer(7),
    sender: { id: uuid(USER_ID), name: like('Sam Sender') },
    editable: status === 'DRAFT',
    documents: opts.documents === true ? eachLike(doc) : [],
    recipients: opts.recipients === true ? eachLike(recipient) : [],
    fields: opts.fields === true ? eachLike(field) : [],
  };
}

let pdfBase64 = '';

beforeAll(async () => {
  pdfBase64 = await letterPdfBase64();
});

describe('esign-web → GET /v1/sign/sender/context', () => {
  it('resolves the sender workspace context server-side', async () => {
    await provider
      .addInteraction()
      .given('an esign sender session exists')
      .uponReceiving('a sender context read from the Aramo Sign console')
      .withRequest('GET', `${BASE}/context`, (b) => {
        b.headers(AUTH_HEADERS);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          user: { id: uuid(USER_ID), email: like('sam.sender@example.com'), display_name: like('Sam Sender') },
          tenant: { id: uuid(TENANT_ID), name: like('Pact Sign Co'), kind: 'BUSINESS' },
          workspace: 'sign',
          permissions: { read: true, create: true, send: true },
          can_send: true,
          personal_sending_enabled: false,
          organization_url: like('https://pact-sign.aramo.ai/org/profile'),
          app_home_url: like('https://pact-sign.aramo.ai/'),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${BASE}/context`, { headers: AUTH_HEADERS });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { workspace: string; can_send: boolean; tenant: { kind: string } };
        expect(body.workspace).toBe('sign');
        expect(body.tenant.kind).toBe('BUSINESS');
        expect(body.can_send).toBe(true);
      });
  });
});

describe('esign-web → GET /v1/sign/sender/envelopes', () => {
  it('lists the tenant envelopes with status counts', async () => {
    await provider
      .addInteraction()
      .given('a sender-authored envelope exists', { envelope_id: LIST_ENVELOPE_ID })
      .uponReceiving('an envelope list read from the Aramo Sign console')
      .withRequest('GET', `${BASE}/envelopes`, (b) => {
        b.headers(AUTH_HEADERS);
      })
      .willRespondWith(200, (b) => {
        // Every envelope in the tenant is listed (a business workspace reads the
        // whole tenant), so the item template carries only the fields that are
        // non-null for EVERY lifecycle state; nullable timestamps and the
        // per-envelope recipients array (empty on a fresh draft) are left to the
        // detail interactions below.
        b.jsonBody({
          items: eachLike({
            id: uuid(LIST_ENVELOPE_ID),
            subject: like('Offer letter'),
            status: regex(STATUS, 'DRAFT'),
            created_at: iso('2026-10-18T10:00:00.000Z'),
            last_activity_at: iso('2026-10-18T10:00:00.000Z'),
            document_count: integer(1),
          }),
          counts: like({ DRAFT: 1 }),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${BASE}/envelopes`, { headers: AUTH_HEADERS });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: { id: string }[]; counts: Record<string, number> };
        expect(body.items.length).toBeGreaterThan(0);
        expect(typeof body.counts).toBe('object');
      });
  });
});

describe('esign-web → POST /v1/sign/sender/envelopes', () => {
  it('creates a DRAFT envelope', async () => {
    await provider
      .addInteraction()
      .given('an esign sender session exists')
      .uponReceiving('a draft envelope create from the Aramo Sign console')
      .withRequest('POST', `${BASE}/envelopes`, (b) => {
        b.headers(JSON_HEADERS).jsonBody({ subject: 'Offer letter' });
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({ id: uuid('e5000000-0000-7000-8000-0000000000aa'), status: 'DRAFT', subject: 'Offer letter' });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${BASE}/envelopes`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ subject: 'Offer letter' }),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { status: string };
        expect(body.status).toBe('DRAFT');
      });
  });
});

describe('esign-web → POST /v1/sign/sender/envelopes/{id}/documents', () => {
  it('uploads a PDF to a draft envelope and returns its PDF-native page geometry', async () => {
    const upload = { filename: 'offer-letter.pdf', title: 'Offer letter', content_base64: pdfBase64 };
    await provider
      .addInteraction()
      .given('a sender draft envelope exists', { envelope_id: UPLOAD_ENVELOPE_ID })
      .uponReceiving('a PDF upload from the Aramo Sign console')
      .withRequest('POST', `${BASE}/envelopes/${UPLOAD_ENVELOPE_ID}/documents`, (b) => {
        b.headers(JSON_HEADERS).jsonBody(upload);
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({
          id: uuid('e5000000-0000-7000-8000-0000000000b2'),
          title: 'Offer letter',
          ordinal: integer(1),
          byte_size: integer(1024),
          page_count: 1,
          pages: [{ width: 612, height: 792 }],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${BASE}/envelopes/${UPLOAD_ENVELOPE_ID}/documents`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify(upload),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { page_count: number; pages: { width: number; height: number }[] };
        expect(body.page_count).toBe(1);
        expect(body.pages[0]).toEqual({ width: 612, height: 792 });
      });
  });
});

describe('esign-web → PUT /v1/sign/sender/envelopes/{id}/recipients', () => {
  it('replaces the draft recipients', async () => {
    const recipients = { recipients: [{ name: 'Jane Doe', email: 'jane@example.com' }] };
    await provider
      .addInteraction()
      .given('a sender draft envelope exists', { envelope_id: RECIPIENTS_ENVELOPE_ID })
      .uponReceiving('a recipients replace from the Aramo Sign console')
      .withRequest('PUT', `${BASE}/envelopes/${RECIPIENTS_ENVELOPE_ID}/recipients`, (b) => {
        b.headers(JSON_HEADERS).jsonBody(recipients);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(detailBody(RECIPIENTS_ENVELOPE_ID, 'DRAFT', { recipients: true }));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${BASE}/envelopes/${RECIPIENTS_ENVELOPE_ID}/recipients`, {
          method: 'PUT',
          headers: JSON_HEADERS,
          body: JSON.stringify(recipients),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { recipients: unknown[] };
        expect(body.recipients.length).toBe(1);
      });
  });
});

// Aramo-Sign-Unified-Product-Amendment-M-A5 §1 / §2 — recipient kinds: a copy
// recipient (with its copy timing) beside a signer; omitted kind = SIGNER.
describe('esign-web → PUT recipients with a copy recipient (M-A5)', () => {
  it('replaces the draft recipients with a signer and a recipient who receives a copy', async () => {
    const recipients = {
      recipients: [
        { name: 'Jane Doe', email: 'jane@example.com', recipient_kind: 'SIGNER', copy_delivery: null },
        { name: 'Casey Copy', email: 'casey@example.com', recipient_kind: 'RECEIVES_COPY', copy_delivery: 'ON_COMPLETION' },
      ],
    };
    await provider
      .addInteraction()
      .given('a sender draft envelope exists', { envelope_id: RECIPIENTS_ENVELOPE_ID })
      .uponReceiving('a recipients replace with a copy recipient from the Aramo Sign console')
      .withRequest('PUT', `${BASE}/envelopes/${RECIPIENTS_ENVELOPE_ID}/recipients`, (b) => {
        b.headers(JSON_HEADERS).jsonBody(recipients);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          id: RECIPIENTS_ENVELOPE_ID,
          status: 'DRAFT',
          recipients: [
            { id: uuid('e5000000-0000-7000-8000-0000000000d4'), name: 'Jane Doe', email: 'jane@example.com', status: 'PENDING', signing_order: 1, recipient_kind: 'SIGNER', copy_delivery: null, assigned_to_me: false, can_remind: false },
            { id: uuid('e5000000-0000-7000-8000-0000000000d5'), name: 'Casey Copy', email: 'casey@example.com', status: 'PENDING', signing_order: 2, recipient_kind: 'RECEIVES_COPY', copy_delivery: 'ON_COMPLETION', assigned_to_me: false, can_remind: false },
          ],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${BASE}/envelopes/${RECIPIENTS_ENVELOPE_ID}/recipients`, {
          method: 'PUT',
          headers: JSON_HEADERS,
          body: JSON.stringify(recipients),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { recipients: { recipient_kind: string }[] };
        expect(body.recipients.map((r) => r.recipient_kind)).toEqual(['SIGNER', 'RECEIVES_COPY']);
      });
  });
});

// Aramo-Sign-Multi-Signer-Amendment §5/§8 — several signers, and signing in order.
describe('esign-web → multiple signers', () => {
  it('replaces the draft recipients with three signers (each with its own signing position)', async () => {
    const recipients = {
      recipients: [
        { name: 'Jane Doe', email: 'jane@example.com' },
        { name: 'Raj Patel', email: 'raj@example.com' },
        { name: 'Lee Chen', email: 'lee@example.com' },
      ],
    };
    await provider
      .addInteraction()
      .given('a sender draft envelope exists', { envelope_id: RECIPIENTS_ENVELOPE_ID })
      .uponReceiving('a three-signer recipients replace from the Aramo Sign console')
      .withRequest('PUT', `${BASE}/envelopes/${RECIPIENTS_ENVELOPE_ID}/recipients`, (b) => {
        b.headers(JSON_HEADERS).jsonBody(recipients);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          id: RECIPIENTS_ENVELOPE_ID,
          status: 'DRAFT',
          recipients: eachLike(
            { id: uuid('e5000000-0000-7000-8000-0000000000d3'), name: like('Jane Doe'), email: like('jane@example.com'), status: 'PENDING', signing_order: integer(1) },
            3,
          ),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${BASE}/envelopes/${RECIPIENTS_ENVELOPE_ID}/recipients`, {
          method: 'PUT',
          headers: JSON_HEADERS,
          body: JSON.stringify(recipients),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { recipients: unknown[] };
        expect(body.recipients.length).toBe(3);
      });
  });

  it('switches a draft to signing in order', async () => {
    await provider
      .addInteraction()
      .given('a sender draft envelope exists', { envelope_id: RECIPIENTS_ENVELOPE_ID })
      .uponReceiving('a routing change to Sign in order from the Aramo Sign console')
      .withRequest('PATCH', `${BASE}/envelopes/${RECIPIENTS_ENVELOPE_ID}`, (b) => {
        b.headers(JSON_HEADERS).jsonBody({ routing_mode: 'SEQUENTIAL' });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ id: RECIPIENTS_ENVELOPE_ID, status: 'DRAFT', routing_mode: 'SEQUENTIAL' });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${BASE}/envelopes/${RECIPIENTS_ENVELOPE_ID}`, {
          method: 'PATCH',
          headers: JSON_HEADERS,
          body: JSON.stringify({ routing_mode: 'SEQUENTIAL' }),
        });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { routing_mode: string }).routing_mode).toBe('SEQUENTIAL');
      });
  });
});

describe('esign-web → PUT /v1/sign/sender/envelopes/{id}/fields', () => {
  it('replaces the draft fields (PDF-native geometry, validated against the source page)', async () => {
    const fields = {
      fields: [
        {
          envelope_document_id: FIELDS_DOC_ID,
          signer_id: FIELDS_SIGNER_ID,
          field_type: 'SIGNATURE',
          page_number: 0,
          x: 72,
          y: 100,
          width: 180,
          height: 40,
          required: true,
        },
      ],
    };
    await provider
      .addInteraction()
      .given('a sender draft envelope with a document and a recipient exists', { envelope_id: FIELDS_ENVELOPE_ID })
      .uponReceiving('a fields replace from the Aramo Sign console')
      .withRequest('PUT', `${BASE}/envelopes/${FIELDS_ENVELOPE_ID}/fields`, (b) => {
        b.headers(JSON_HEADERS).jsonBody(fields);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(detailBody(FIELDS_ENVELOPE_ID, 'DRAFT', { documents: true, recipients: true, fields: true }));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${BASE}/envelopes/${FIELDS_ENVELOPE_ID}/fields`, {
          method: 'PUT',
          headers: JSON_HEADERS,
          body: JSON.stringify(fields),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { fields: { field_type: string }[] };
        expect(body.fields[0]?.field_type).toBe('SIGNATURE');
      });
  });
});

describe('esign-web → POST /v1/sign/sender/envelopes/{id}/send', () => {
  it('sends a ready draft envelope', async () => {
    await provider
      .addInteraction()
      .given('a sender draft envelope is ready to send', { envelope_id: SEND_ENVELOPE_ID })
      .uponReceiving('a send from the Aramo Sign console')
      .withRequest('POST', `${BASE}/envelopes/${SEND_ENVELOPE_ID}/send`, (b) => {
        b.headers(JSON_HEADERS).jsonBody({});
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(detailBody(SEND_ENVELOPE_ID, 'SENT', { documents: true, recipients: true, fields: true, sentAt: true }));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${BASE}/envelopes/${SEND_ENVELOPE_ID}/send`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string };
        expect(body.status).toBe('SENT');
      });
  });
});

describe('esign-web → POST /v1/sign/sender/envelopes/{id}/void', () => {
  it('voids a sent envelope with a reason', async () => {
    await provider
      .addInteraction()
      .given('a sent sender envelope exists', { envelope_id: VOID_ENVELOPE_ID })
      .uponReceiving('a void from the Aramo Sign console')
      .withRequest('POST', `${BASE}/envelopes/${VOID_ENVELOPE_ID}/void`, (b) => {
        b.headers(JSON_HEADERS).jsonBody({ reason: 'Sent to the wrong recipient' });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(detailBody(VOID_ENVELOPE_ID, 'VOIDED', { documents: true, recipients: true, fields: true, sentAt: true, voidedAt: true }));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${BASE}/envelopes/${VOID_ENVELOPE_ID}/void`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ reason: 'Sent to the wrong recipient' }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string };
        expect(body.status).toBe('VOIDED');
      });
  });
});

describe('Sign Mobile → GET /v1/sign/sender/envelopes/{id} (ETag)', () => {
  it('returns the revision validator, the sender message and the two expiry fields', async () => {
    await provider
      .addInteraction()
      .given('a sender-authored envelope exists', { envelope_id: ETAG_ENVELOPE_ID })
      .uponReceiving('an envelope detail read with its ETag')
      .withRequest('GET', `${BASE}/envelopes/${ETAG_ENVELOPE_ID}`, (b) => {
        b.headers(AUTH_HEADERS);
      })
      .willRespondWith(200, (b) => {
        b.headers({ ETag: regex(`^"${ETAG_ENVELOPE_ID}\\.\\d+"$`, `"${ETAG_ENVELOPE_ID}.5"`) });
        b.jsonBody({
          ...detailBody(ETAG_ENVELOPE_ID, 'DRAFT', { documents: true, recipients: true, fields: true }),
          revision: integer(5),
          message: null,
          signing_link_valid_days: 7,
          envelope_expires_at: null,
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${BASE}/envelopes/${ETAG_ENVELOPE_ID}`, { headers: AUTH_HEADERS });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { revision: number };
        expect(res.headers.get('etag')).toBe(`"${ETAG_ENVELOPE_ID}.${body.revision}"`);
      });
  });
});

describe('Sign Mobile → PATCH /v1/sign/sender/envelopes/{id} (If-Match)', () => {
  it('sets the sender message on a draft when If-Match is current', async () => {
    const etag = `"${MESSAGE_ENVELOPE_ID}.2"`;
    await provider
      .addInteraction()
      .given('a sender draft envelope exists', { envelope_id: MESSAGE_ENVELOPE_ID })
      .uponReceiving('a sender message change with a current If-Match')
      .withRequest('PATCH', `${BASE}/envelopes/${MESSAGE_ENVELOPE_ID}`, (b) => {
        b.headers({ ...JSON_HEADERS, 'If-Match': etag }).jsonBody({ message: 'Please sign by Friday.' });
      })
      .willRespondWith(200, (b) => {
        b.headers({ ETag: regex(`^"${MESSAGE_ENVELOPE_ID}\\.\\d+"$`, `"${MESSAGE_ENVELOPE_ID}.3"`) });
        b.jsonBody({ id: MESSAGE_ENVELOPE_ID, status: 'DRAFT', message: 'Please sign by Friday.', revision: integer(3) });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${BASE}/envelopes/${MESSAGE_ENVELOPE_ID}`, {
          method: 'PATCH',
          headers: { ...JSON_HEADERS, 'If-Match': etag },
          body: JSON.stringify({ message: 'Please sign by Friday.' }),
        });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { message: string }).message).toBe('Please sign by Friday.');
      });
  });

  it('refuses a stale If-Match with 412 revision_mismatch and the current revision', async () => {
    const stale = `"${STALE_ENVELOPE_ID}.1"`;
    await provider
      .addInteraction()
      .given('a sender draft envelope exists', { envelope_id: STALE_ENVELOPE_ID })
      .uponReceiving('a draft change with a stale If-Match')
      .withRequest('PATCH', `${BASE}/envelopes/${STALE_ENVELOPE_ID}`, (b) => {
        b.headers({ ...JSON_HEADERS, 'If-Match': stale }).jsonBody({ subject: 'Renamed' });
      })
      .willRespondWith(412, (b) => {
        b.jsonBody({
          error: {
            code: 'INVALID_REQUEST',
            message: like('This envelope changed since you last read it. Reload and try again.'),
            request_id: like('req-1'),
            details: { reason: 'revision_mismatch', current_revision: integer(2) },
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${BASE}/envelopes/${STALE_ENVELOPE_ID}`, {
          method: 'PATCH',
          headers: { ...JSON_HEADERS, 'If-Match': stale },
          body: JSON.stringify({ subject: 'Renamed' }),
        });
        expect(res.status).toBe(412);
        expect(((await res.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe('revision_mismatch');
      });
  });
});

describe('Sign Mobile → /v1/sign/sender/contacts (saved contacts)', () => {
  it('saves a private contact', async () => {
    const body = { name: 'Priya Nair', email: 'priya.contact@example.com', organization: 'Northwind' };
    await provider
      .addInteraction()
      .given('an esign sender session exists')
      .uponReceiving('a saved contact create from the Aramo Sign console')
      .withRequest('POST', `${BASE}/contacts`, (b) => {
        b.headers(JSON_HEADERS).jsonBody(body);
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({
          id: uuid('e5000000-0000-7000-8000-000000000201'),
          name: 'Priya Nair',
          email: 'priya.contact@example.com',
          organization: 'Northwind',
          source: 'saved',
          created_at: iso('2026-10-25T10:00:00.000Z'),
          updated_at: iso('2026-10-25T10:00:00.000Z'),
          last_used_at: null,
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${BASE}/contacts`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
        expect(res.status).toBe(201);
        expect(((await res.json()) as { source: string }).source).toBe('saved');
      });
  });

});

describe('esign-web → GET /v1/sign/sender/envelopes (no session)', () => {
  it('is refused with AUTH_REQUIRED when no esign session cookie is present', async () => {
    await provider
      .addInteraction()
      .uponReceiving('an envelope list read without an esign session')
      .withRequest('GET', `${BASE}/envelopes`, (b) => {
        b.headers({ 'X-Aramo-Consumer': 'sign' });
      })
      .willRespondWith(401, (b) => {
        b.jsonBody({
          error: {
            code: 'AUTH_REQUIRED',
            message: like('Authorization required'),
            request_id: like('req-1'),
            details: like({}),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${BASE}/envelopes`, { headers: { 'X-Aramo-Consumer': 'sign' } });
        expect(res.status).toBe(401);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('AUTH_REQUIRED');
      });
  });
});

// CCP-A6 (Conversion Rule C-1, C-4) — a tenant holding an open governed (MANUAL, Aramo-managed)
// Sign subscription: the billing owner's self-service checkout is refused with the NEW typed
// refusal (never ALREADY_SUBSCRIBED, whose meaning stays "an open self-service row"). The
// billing owner is a DISTINCT seeded principal (placeholder cookie value below; the verifier
// swaps in its real token). No provider call is made: the refusal precedes every side effect.
const BILLING_OWNER_COOKIE = 'aramo_access_token_sign=sign-workspace-pact-billing-owner';
describe('sign-workspace → POST /v1/sign/billing/checkout (governed subscription open)', () => {
  it('is refused 409 ESIGN_BILLING_CONFLICT reason governed_subscription_open', async () => {
    const headers = { 'X-Aramo-Consumer': 'sign', Cookie: BILLING_OWNER_COOKIE, 'Content-Type': 'application/json' };
    const body = { plan_key: 'aramo-sign-standard-business-v1', accept_terms: true };
    await provider
      .addInteraction()
      .given('a business tenant holds a governed Aramo-managed Sign subscription')
      .uponReceiving('a self-service checkout by the billing owner of a tenant with a governed subscription')
      .withRequest('POST', '/v1/sign/billing/checkout', (b) => {
        b.headers(headers).jsonBody(body);
      })
      .willRespondWith(409, (b) => {
        b.jsonBody({
          error: {
            code: 'ESIGN_BILLING_CONFLICT',
            message: like('Your organization’s subscription is managed by Aramo. Contact Aramo to change it.'),
            request_id: like('req-1'),
            details: { reason: 'governed_subscription_open' },
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/billing/checkout`, { method: 'POST', headers, body: JSON.stringify(body) });
        expect(res.status).toBe(409);
        const out = (await res.json()) as { error: { code: string; details: { reason: string } } };
        expect(out.error.details.reason).toBe('governed_subscription_open');
      });
  });
});

// CCP-A6-R (Conversion Rule C-8; Architect disposition TD-A6-12) — a held self-service activation
// reaches the tenant's billing owner as a SAFE pending state only: the account read keeps the
// governed subscription as it is and adds `pending_activation` with the fixed support copy; no
// flag, reason or contract detail is exposed, and nothing reports an activation.
describe('sign-workspace → GET /v1/sign/billing/account (held activation)', () => {
  it('returns the governed subscription and the safe pending_activation state', async () => {
    const headers = { 'X-Aramo-Consumer': 'sign', Cookie: BILLING_OWNER_COOKIE };
    await provider
      .addInteraction()
      .given('a business tenant with a governed subscription has a held self-service activation')
      .uponReceiving('a billing account read by the billing owner of a tenant with a held activation')
      .withRequest('GET', '/v1/sign/billing/account', (b) => {
        b.headers(headers);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          subscription: { plan_key: 'aramo-sign-included-v1', source: 'MANUAL', status: 'ACTIVE' },
          pending_activation: { state: 'PENDING', message: 'Subscription activation pending — contact support' },
          // CCP-C5 — the designed disabled tax state.
          tax: { enabled: false, reason: 'STRIPE_TAX_NOT_REGISTERED' },
          tenant_kind: 'BUSINESS',
          can_manage_billing: true,
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/billing/account`, { headers });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { pending_activation: { state: string } };
        expect(body.pending_activation.state).toBe('PENDING');
      });
  });
});

// CCP-C7 (PBD §5.2 row C7, §10) — tenant self-service while the Sign Terms of Service are not
// APPROVED (the shipped legal registry): the view offers no action and names the stable reason; the
// owner's cancel is refused with the designed disabled state before any write or provider call. The
// terms gate precedes the governed-subscription gate, so this tenant (governed) reads the terms state.
describe('sign-workspace → GET /v1/sign/billing/self-service (terms not approved)', () => {
  it('returns every self-service action unavailable with reason SELF_SERVICE_TERMS_NOT_APPROVED', async () => {
    const headers = { 'X-Aramo-Consumer': 'sign', Cookie: BILLING_OWNER_COOKIE };
    const off = { available: false, reason: 'SELF_SERVICE_TERMS_NOT_APPROVED' };
    await provider
      .addInteraction()
      .given('a business tenant holds a governed Aramo-managed Sign subscription')
      .uponReceiving('a self-service billing read by the billing owner while the Sign terms are not approved')
      .withRequest('GET', '/v1/sign/billing/self-service', (b) => {
        b.headers(headers);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          product_key: 'sign',
          terms: { state: 'NOT_APPROVED', document_key: 'sign.terms_of_service', version: null, url: null },
          pending_provider: false,
          actions: { cancel: off, upgrade: off },
          can_manage_billing: true,
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/billing/self-service`, { headers });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { actions: { cancel: { available: boolean } } };
        expect(body.actions.cancel.available).toBe(false);
      });
  });
});

describe('sign-workspace → POST /v1/sign/billing/self-service/cancel (terms not approved)', () => {
  it('is refused 503 ESIGN_BILLING_UNAVAILABLE reason self_service_terms_not_approved', async () => {
    const headers = { 'X-Aramo-Consumer': 'sign', Cookie: BILLING_OWNER_COOKIE, 'Content-Type': 'application/json' };
    await provider
      .addInteraction()
      .given('a business tenant holds a governed Aramo-managed Sign subscription')
      .uponReceiving('a self-service cancel by the billing owner while the Sign terms are not approved')
      .withRequest('POST', '/v1/sign/billing/self-service/cancel', (b) => {
        b.headers(headers).jsonBody({});
      })
      .willRespondWith(503, (b) => {
        b.jsonBody({
          error: {
            code: 'ESIGN_BILLING_UNAVAILABLE',
            message: like('Changing your plan online isn’t available yet. Contact Aramo to change your subscription.'),
            request_id: like('req-1'),
            details: { reason: 'self_service_terms_not_approved' },
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/billing/self-service/cancel`, { method: 'POST', headers, body: '{}' });
        expect(res.status).toBe(503);
        const out = (await res.json()) as { error: { details: { reason: string } } };
        expect(out.error.details.reason).toBe('self_service_terms_not_approved');
      });
  });
});

describe('sign-workspace → GET /v1/sign/legal/notices (nothing announced)', () => {
  it('answers an empty notice list while no upcoming legal version is announced', async () => {
    await provider
      .addInteraction()
      .given('an esign sender session exists')
      .uponReceiving('an upcoming legal-version notice read from the Aramo Sign workspace')
      .withRequest('GET', '/v1/sign/legal/notices', (b) => {
        b.headers(AUTH_HEADERS);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ notices: [] });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/legal/notices`, { headers: AUTH_HEADERS });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ notices: [] });
      });
  });
});

afterAll(() => undefined);
