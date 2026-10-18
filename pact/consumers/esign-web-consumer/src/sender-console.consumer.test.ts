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
//                             `esign` session, never sent).
// Provider:  esign-service   (apps/esign-service, EsignSenderController at
//                             `v1/esign/sender`).
//
// Mirrors the EXACT request shapes senderApi issues through the fe-foundation
// ApiClient (method / path / JSON body, `X-Aramo-Consumer: esign`, and the
// browser-attached consumer-isolated session cookie `aramo_access_token_esign`).
// Per the established harness convention (sign-web-consumer, esign-consumer,
// ats-web) the interactions are issued as raw fetches matching the client: the
// production client is an apps/esign-web module using relative paths and a
// browser cookie jar, and an app module is not import-invokable from a pact
// project without crossing the nx project boundary.
//
// The session cookie value is a PLACEHOLDER; the provider verifier rewrites it
// to a real RS256 `esign` access token for the seeded sender (verify-esign.ts
// requestFilter). The 401 interaction carries no cookie and is left untouched.
//
// Each mutating op targets its OWN envelope id so the provider seeds an
// INDEPENDENT fixture per interaction — SignatureEvent is append-only (no
// delete), so shared-envelope re-seeding is impossible.
//
// Coverage (api.ts senderApi):
//   1. GET  /v1/esign/sender/context                         200 SenderContext
//   2. GET  /v1/esign/sender/envelopes                       200 { items, counts }
//   3. POST /v1/esign/sender/envelopes                       201 { id, status, subject }
//   4. POST /v1/esign/sender/envelopes/{id}/documents        201 UploadedDocument
//   5. PUT  /v1/esign/sender/envelopes/{id}/recipients       200 EnvelopeDetail
//   6. PUT  /v1/esign/sender/envelopes/{id}/fields           200 EnvelopeDetail
//   7. POST /v1/esign/sender/envelopes/{id}/send             200 EnvelopeDetail (SENT)
//   8. POST /v1/esign/sender/envelopes/{id}/void             200 EnvelopeDetail (VOIDED)
//   9. GET  /v1/esign/sender/envelopes (no session)          401 AUTH_REQUIRED

const provider = new PactV4({
  consumer: 'esign-web',
  provider: 'esign-service',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

// Fixed values — MUST match the per-op seeds in pact/provider/src/verify-esign.ts.
const BASE = '/v1/esign/sender';
const SESSION_COOKIE = 'aramo_access_token_esign=esign-web-pact-session';
const AUTH_HEADERS = { 'X-Aramo-Consumer': 'esign', Cookie: SESSION_COOKIE };
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

describe('esign-web → GET /v1/esign/sender/context', () => {
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

describe('esign-web → GET /v1/esign/sender/envelopes', () => {
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

describe('esign-web → POST /v1/esign/sender/envelopes', () => {
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

describe('esign-web → POST /v1/esign/sender/envelopes/{id}/documents', () => {
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

describe('esign-web → PUT /v1/esign/sender/envelopes/{id}/recipients', () => {
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

describe('esign-web → PUT /v1/esign/sender/envelopes/{id}/fields', () => {
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

describe('esign-web → POST /v1/esign/sender/envelopes/{id}/send', () => {
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

describe('esign-web → POST /v1/esign/sender/envelopes/{id}/void', () => {
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

describe('esign-web → GET /v1/esign/sender/envelopes (no session)', () => {
  it('is refused with AUTH_REQUIRED when no esign session cookie is present', async () => {
    await provider
      .addInteraction()
      .uponReceiving('an envelope list read without an esign session')
      .withRequest('GET', `${BASE}/envelopes`, (b) => {
        b.headers({ 'X-Aramo-Consumer': 'esign' });
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
        const res = await fetch(`${mock.url}${BASE}/envelopes`, { headers: { 'X-Aramo-Consumer': 'esign' } });
        expect(res.status).toBe(401);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('AUTH_REQUIRED');
      });
  });
});

afterAll(() => undefined);
