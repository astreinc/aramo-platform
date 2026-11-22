// FIELD-PARITY-1 (Sign Field Placement Enterprise Parity Directive v1.0 LOCKED) — the console
// fixed-form Studio fixture shared by the fixed-form journeys (P0-1 scrolling, P2 repeat down
// and align): an N-page PDF generated with pdf-lib, the fixed-form routes answered by the
// fixture provider, and the Studio opened on that draft. The layout save echoes the saved
// fields back, as the API does.

import { expect, type Page } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';

import { openBuild } from '../support/build';

import type { MockOptions } from './mock-api';

export const FIXED_FORM_PAGE = { width: 612, height: 792 };

export interface FixedFormFixture {
  readonly templateId: string;
  readonly title: string;
  readonly pages: number;
}

export async function fixedFormPdf(pages: number): Promise<string> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i += 1) {
    const p = doc.addPage([FIXED_FORM_PAGE.width, FIXED_FORM_PAGE.height]);
    p.drawText(`Official form · page ${i} of ${pages}`, { x: 72, y: FIXED_FORM_PAGE.height - 72, size: 18, font });
  }
  // Fixed dates keep the bytes deterministic.
  doc.setCreationDate(new Date('2026-01-01T00:00:00Z'));
  doc.setModificationDate(new Date('2026-01-01T00:00:00Z'));
  return Buffer.from(await doc.save()).toString('base64');
}

export function fixedFormMock(fx: FixedFormFixture, pdfBase64: string): MockOptions {
  const at = '2026-10-01T00:00:00.000Z';
  const versionId = `${fx.templateId}_v1`;
  const view = {
    template_id: fx.templateId,
    version_id: versionId,
    version_number: 1,
    status: 'DRAFT',
    content: {
      render_schema_version: 'fixed-form-pdf-v1',
      title: fx.title,
      pdf: { asset_id: `asset_${fx.templateId}`, sha256: 'a'.repeat(64), byte_size: Math.floor((pdfBase64.length * 3) / 4), page_count: fx.pages, pages: Array.from({ length: fx.pages }, () => FIXED_FORM_PAGE) },
      signing: { roles: [{ role_key: 'employee', label: 'Employee', kind: 'SIGNER', order: 1 }], routing_mode: 'PARALLEL' },
    },
    fields: [] as unknown[],
    variables: [],
    issues: [{ code: 'fields_required', message: 'Place at least one field.' }],
    previewed: false,
  };
  const typeId = `dty_${fx.templateId}`;
  return {
    overrides: [
      {
        path: /^\/platform\/document-templates\/document-types$/,
        reply: {
          body: {
            document_types: [{ id: typeId, key: fx.templateId.toUpperCase(), name: fx.title, configurable: false, template_kind: 'FIXED_FORM', products: ['sign'], category: 'Employment' }],
          },
        },
      },
      {
        path: new RegExp(`^/platform/document-templates/${fx.templateId}$`),
        reply: {
          body: {
            id: fx.templateId,
            owner_scope: 'PLATFORM',
            document_type_id: typeId,
            name: fx.title,
            description: null,
            template_kind: 'UPLOADED_PDF',
            status: 'DRAFT',
            products: ['sign'],
            current_version: null,
            draft_version_id: versionId,
            withdraw_notice_at: null,
            withdraw_effective_at: null,
            created_at: at,
            updated_at: at,
            versions: [],
          },
        },
      },
      { path: new RegExp(`^/platform/document-templates/versions/${versionId}/fixed-form$`), reply: { body: view } },
      { path: new RegExp(`^/platform/document-templates/versions/${versionId}/fixed-form/pdf$`), reply: { body: { sha256: 'a'.repeat(64), byte_size: view.content.pdf.byte_size, content_base64: pdfBase64 } } },
      {
        method: 'PUT',
        path: new RegExp(`^/platform/document-templates/versions/${versionId}/fixed-form/layout$`),
        reply: ({ body }) => {
          const b = body as { fields?: unknown[]; signing?: unknown };
          return { body: { ...view, content: { ...view.content, signing: b.signing ?? view.content.signing }, fields: b.fields ?? [], issues: [] } };
        },
      },
    ],
  };
}

/**
 * FIELD-PARITY-1 P2-4..P2-6 journeys add their own routes (the PDF upload with its import
 * result, the field suggestions); they are checked before the fixture's.
 */
export async function openFixedFormStudio(page: Page, fx: FixedFormFixture, extra: Pick<MockOptions, 'overrides'> = {}): Promise<void> {
  // The renderer's worker is imported as `pdfjs-dist/build/pdf.worker.min.mjs?url`. The Vite dev
  // server answers that with `export default "<url>"` only when node_modules sits inside the
  // workspace root; with node_modules linked from outside it (a git worktree) it serves the raw
  // worker and pdf.js refuses it. Answer the import as Vite does in a plain checkout.
  await page.route(/pdf\.worker\.min\.mjs\?url$/, (route) => {
    const u = new URL(route.request().url());
    return route.fulfill({ contentType: 'text/javascript', body: `export default ${JSON.stringify(u.pathname)};` });
  });
  const base = fixedFormMock(fx, await fixedFormPdf(fx.pages));
  await openBuild(page, `/document-templates/${fx.templateId}`, { ...base, overrides: [...(extra.overrides ?? []), ...(base.overrides ?? [])] });
  await expect(page.getByTestId('fixed-form-studio')).toBeVisible();
  await expect(page.getByTestId(`ffs-page-${fx.pages - 1}`)).toBeVisible();
}
