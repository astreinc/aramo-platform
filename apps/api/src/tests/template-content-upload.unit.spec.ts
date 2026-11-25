import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { TEMPLATE_CONTENT_WRITE_MAX_BODY, isTemplateContentWrite } from '../document-templates-platform/template-content-upload.constants.js';

// TEMPLATE-CONTENT-2 C-7 — only the template version WRITE routes get the larger JSON limit.
describe('template content write routes (route-scoped 1 MB JSON parser)', () => {
  it('matches the platform, tenant and Sign Personal version writes only', () => {
    for (const p of [
      '/platform/document-templates/t1/versions',
      '/platform/document-templates/versions/v1',
      '/v1/document-templates/t1/versions',
      '/v1/document-templates/versions/v1',
      '/v1/documents/esign/templates/studio/t1/versions',
      '/v1/documents/esign/templates/studio/versions/v1',
    ]) {
      expect(isTemplateContentWrite('POST', p) || isTemplateContentWrite('PATCH', p)).toBe(true);
    }
    for (const p of ['/platform/document-templates/versions/v1/publish', '/platform/document-templates/versions/v1/fixed-form/pdf', '/v1/document-templates', '/v1/talents/x']) {
      expect(isTemplateContentWrite('POST', p)).toBe(false);
    }
    expect(isTemplateContentWrite('GET', '/v1/document-templates/versions/v1')).toBe(false);
  });

  it('a 250 KiB body is accepted on a write route and refused elsewhere (100 kB default)', async () => {
    const app = express();
    const big = express.json({ limit: TEMPLATE_CONTENT_WRITE_MAX_BODY });
    app.use((req, res, next) => (isTemplateContentWrite(req.method, req.path) ? big(req, res, next) : next()));
    app.use(express.json());
    app.use((req, res) => res.status(200).json({ size: JSON.stringify(req.body).length }));
    const body = { field_schema: { html: `<p>${'x'.repeat(250 * 1024)}</p>` } };
    expect((await request(app).patch('/v1/document-templates/versions/v1').send(body)).status).toBe(200);
    expect((await request(app).post('/v1/talents/x').send(body)).status).toBe(413);
  });
});
