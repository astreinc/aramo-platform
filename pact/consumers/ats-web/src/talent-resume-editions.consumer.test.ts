import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ACCESS_COOKIE,
  ISO_TIMESTAMP,
  like,
  makeAtsWebProvider,
  regex,
  uuid,
} from './support/ats-web-pact.js';

// TALENT-INTEL-1 TI-1D-C — Pact consumer for ats-web résumé editions (GET list /
// POST ingest / PUT default). Multiple editions coexist; the default is explicit
// (never latest-wins); filename/mime_type/uploaded_at are projected from the
// TalentDocument. Guard chain: @RequireCapability('ats') + talent:read (GET) /
// talent:edit (POST, PUT) + @RequireSiteMatch().

const provider = makeAtsWebProvider();

const TALENT_ID = '00000000-0000-7000-8000-7a0000000017';
const ED_A = '00000000-0000-7000-8000-7e0000000001';
const ED_B = '00000000-0000-7000-8000-7e0000000002';
const DOC_A = '00000000-0000-7000-8000-7d0000000001';
const DOC_B = '00000000-0000-7000-8000-7d0000000002';
const ATT_ID = '00000000-0000-7000-8000-7f0000000001';

function editionRow(over: Record<string, unknown>) {
  return {
    edition_id: uuid((over['edition_id'] as string) ?? ED_A),
    talent_document_id: uuid((over['talent_document_id'] as string) ?? DOC_A),
    attachment_id: over['attachment_id'] ?? null,
    purpose: over['purpose'] ?? 'GENERAL',
    label: over['label'] ?? null,
    lifecycle_status: 'active',
    created_at: regex(ISO_TIMESTAMP, '2026-07-01T00:00:00Z'),
    filename: like((over['filename'] as string) ?? 'grace-general.pdf'),
    mime_type: like((over['mime_type'] as string) ?? 'application/pdf'),
    uploaded_at: regex(ISO_TIMESTAMP, '2026-07-01T00:00:00Z'),
    is_default: over['is_default'] ?? false,
    // TI-1F-A — DERIVED from the edition's ResumeExtractionDraft; null for
    // editions seeded without a draft (the list-read provider state).
    processing_status: over['processing_status'] ?? null,
  };
}

describe('ats-web → GET /v1/talent-records/:id/resume-editions', () => {
  it('returns 200 with the edition collection (default is the explicit, not the newest)', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a talent with resume editions exist')
      .uponReceiving('a résumé-edition list read')
      .withRequest('GET', `/v1/talent-records/${TALENT_ID}/resume-editions`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          talent_id: uuid(TALENT_ID),
          // newest-first: ED_B then ED_A; ED_A (older) is the explicit default.
          editions: [
            editionRow({ edition_id: ED_B, talent_document_id: DOC_B, purpose: 'CLIENT_SUBMITTAL', filename: 'grace-genai.docx', is_default: false }),
            editionRow({ edition_id: ED_A, talent_document_id: DOC_A, purpose: 'GENERAL', filename: 'grace-general.pdf', is_default: true }),
          ],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/talent-records/${TALENT_ID}/resume-editions`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { editions: Array<{ is_default: boolean; edition_id: string }> };
        expect(body.editions).toHaveLength(2);
        const def = body.editions.find((e) => e.is_default);
        expect(def?.edition_id).toBe(ED_A); // explicit default, not the newest
      });
  });
});

describe('ats-web → POST /v1/talent-records/:id/resume-editions', () => {
  it('returns 201 with the created edition (first edition → default)', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a talent with an owned resume attachment exist')
      .uponReceiving('a résumé-edition ingestion from an owned attachment')
      .withRequest('POST', `/v1/talent-records/${TALENT_ID}/resume-editions`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
        b.jsonBody({ attachment_id: uuid(ATT_ID), purpose: 'GENERAL' });
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({
          edition_id: like('00000000-0000-7000-8000-000000000abc'),
          talent_document_id: like('00000000-0000-7000-8000-000000000def'),
          attachment_id: uuid(ATT_ID),
          purpose: 'GENERAL',
          label: null,
          lifecycle_status: 'active',
          created_at: regex(ISO_TIMESTAMP, '2026-07-01T00:00:00Z'),
          filename: like('grace-new.pdf'),
          mime_type: like('application/pdf'),
          uploaded_at: regex(ISO_TIMESTAMP, '2026-07-01T00:00:00Z'),
          is_default: true,
          // TI-1F-A — the ingestion enqueues a PROCESSING ResumeExtractionDraft;
          // the created edition projects that governed-extraction lifecycle.
          processing_status: like('PROCESSING'),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/talent-records/${TALENT_ID}/resume-editions`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify({ attachment_id: ATT_ID, purpose: 'GENERAL' }),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { is_default: boolean };
        expect(body.is_default).toBe(true);
      });
  });
});

describe('ats-web → PUT /v1/talent-records/:id/resume-editions/default', () => {
  it('returns 200 with the collection after explicitly setting the default', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a talent with a resume edition exist')
      .uponReceiving('an explicit résumé-edition default change')
      .withRequest('PUT', `/v1/talent-records/${TALENT_ID}/resume-editions/default`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
        b.jsonBody({ resume_edition_id: uuid(ED_A) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          talent_id: uuid(TALENT_ID),
          editions: [editionRow({ edition_id: ED_A, talent_document_id: DOC_A, purpose: 'GENERAL', filename: 'grace.pdf', is_default: true })],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/talent-records/${TALENT_ID}/resume-editions/default`, {
          method: 'PUT',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify({ resume_edition_id: ED_A }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { editions: Array<{ is_default: boolean }> };
        expect(body.editions[0].is_default).toBe(true);
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
