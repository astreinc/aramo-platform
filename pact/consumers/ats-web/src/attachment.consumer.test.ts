import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ACCESS_COOKIE,
  ISO_TIMESTAMP,
  TENANT_ID,
  like,
  makeAtsWebProvider,
  regex,
  uuid,
} from './support/ats-web-pact.js';

// PC-5d — Pact consumer for ats-web, attachment domain (Gate-2a desk, part 4 —
// FINAL increment; this closes the contracted desk). Merges into
// ats-web-aramo-core.json.
//
// Scope (PC-5 Directive §3 + Gate-5 ruling): 2 happy interactions —
//   - GET /v1/attachments (list for a talent owner; owner_type + owner_id
//     query params are required);
//   - POST /v1/attachments (create, 201).
//
// illegal-state: 0-by-substrate (attachment is immutable once created).
// idempotency: 0-by-substrate (no Idempotency-Key).
// refusal: 0-by-ruling (owner-pair 422 + validateOwner 404 are refusals for
//   params the FE constrains -> hardening park; GET /v1/attachments/:id and
//   DELETE /v1/attachments/:id are EXCLUDE-R2, no ats-web call site).
//
// owner_type is 'talent' (the substrate enum value; NOT 'talent_record' —
// that is the task domain's value). validateOwner requires the talent owner
// row to exist, so the provider seeds a talent_record.TalentRecord.
//
// Provider guard chain: @RequireCapability('ats') + @RequireScopes
// (attachment:read/create) + @RequireSiteMatch(). Attachment is owner-scoped
// (no visibility resolver).

const provider = makeAtsWebProvider();

const ATT_ID = '00000000-0000-7000-8000-a77ac0000001';
const ATT_TALENT_ID = '00000000-0000-7000-8000-7a1e00000002';

function attachmentView(id: string | undefined, opts: { fileName?: string } = {}) {
  return {
    id: id === undefined ? uuid() : uuid(id),
    tenant_id: uuid(TENANT_ID),
    site_id: null,
    owner_type: like('talent'),
    owner_id: uuid(ATT_TALENT_ID),
    file_name: like(opts.fileName ?? 'resume.pdf'),
    mime: like('application/pdf'),
    size_bytes: like(1024),
    storage_key: like('s3://bucket/resume.pdf'),
    is_resume: like(false),
    uploaded_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
    created_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
    updated_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
  };
}

// ======================================================================
// GET /v1/attachments — happy (list for owner)
// ======================================================================
describe('ats-web → GET /v1/attachments', () => {
  it('returns 200 with the owner attachment list', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and an attachment exist')
      .uponReceiving('an attachments list read for a talent owner')
      .withRequest('GET', '/v1/attachments', (b) => {
        b.query({ owner_type: 'talent', owner_id: ATT_TALENT_ID }).headers({
          Cookie: like(ACCESS_COOKIE),
        });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ items: [attachmentView(ATT_ID)] });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/attachments?owner_type=talent&owner_id=${ATT_TALENT_ID}`,
          { headers: { Cookie: ACCESS_COOKIE } },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: unknown[] };
        expect(body.items.length).toBeGreaterThan(0);
      });
  });
});

// ======================================================================
// POST /v1/attachments — happy (create; 201)
// ======================================================================
describe('ats-web → POST /v1/attachments', () => {
  it('returns 201 with the created attachment', async () => {
    const CREATE_BODY = {
      owner_type: 'talent',
      owner_id: ATT_TALENT_ID,
      file_name: 'cover-letter.pdf',
      mime: 'application/pdf',
      size_bytes: 2048,
      storage_key: 's3://bucket/cover-letter.pdf',
    };
    await provider
      .addInteraction()
      .given('an ats-web recruiter can create attachments')
      .uponReceiving('an attachment create')
      .withRequest('POST', '/v1/attachments', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(
          CREATE_BODY,
        );
      })
      .willRespondWith(201, (b) => {
        b.jsonBody(attachmentView(undefined, { fileName: 'cover-letter.pdf' }));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/attachments`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(CREATE_BODY),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { file_name: string };
        expect(body.file_name).toBe('cover-letter.pdf');
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
