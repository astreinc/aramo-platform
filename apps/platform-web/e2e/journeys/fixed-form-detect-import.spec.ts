// FIELD-PARITY-1 §5 P2-4 / P2-5 / P2-6 (Sign Field Placement Enterprise Parity Directive v1.0
// LOCKED; §8 item 6 "console Studio fixed-form journeys: … detect") — in the console's fixed-form
// Studio: upload a PDF with "Import fields from a fillable PDF" and "Apply text tags" ticked (the
// flags are sent, the result is shown in plain language), then "Find fields" and accept every
// suggestion as one undo step, and save them.

import { expect, test, type Page } from '@playwright/test';

import { fixedFormPdf, openFixedFormStudio } from '../fixtures/fixed-form';

const FX = { templateId: 'dt_ffdetect', title: 'Meeting minutes', pages: 1 };
const VERSION = `${FX.templateId}_v1`;
const fields = (page: Page) => page.getByTestId('ffs-page-0').locator('[data-field-id]');
const ghosts = (page: Page) => page.getByTestId('ffs-page-0').locator('[data-ghost-id]');

const SUGGESTIONS = {
  suggestions: [
    { type: 'SIGNATURE', page: 1, page_number: 0, x: 72, y: 100, width: 230, height: 50, reason: 'label:Signature', confidence: 0.95 },
    { type: 'TEXT', page: 1, page_number: 0, x: 72, y: 500, width: 300, height: 22, reason: 'label:Title', confidence: 0.8 },
    { type: 'CHECKBOX', page: 1, page_number: 0, x: 72, y: 400, width: 12, height: 12, reason: 'checkbox_glyph', confidence: 0.85 },
  ],
  skipped_pages: [],
};

test('P2-5 / P2-6 · upload with both options: the flags are sent and the import result is shown', async ({ page }) => {
  const uploads: Record<string, unknown>[] = [];
  const pdf = await fixedFormPdf(1);
  await openFixedFormStudio(page, FX, {
    overrides: [
      {
        method: 'PUT',
        path: new RegExp(`^/platform/document-templates/versions/${VERSION}/fixed-form/pdf$`),
        reply: ({ body }) => {
          uploads.push(body as Record<string, unknown>);
          return {
            body: {
              template_id: FX.templateId,
              version_id: VERSION,
              version_number: 1,
              status: 'DRAFT',
              content: {
                render_schema_version: 'fixed-form-pdf-v1',
                title: FX.title,
                pdf: { asset_id: 'asset_2', sha256: 'b'.repeat(64), byte_size: 1000, page_count: 1, pages: [{ width: 612, height: 792 }] },
                signing: { roles: [{ role_key: 'employee', label: 'Employee', kind: 'SIGNER', order: 1 }], routing_mode: 'PARALLEL' },
              },
              fields: [{ field_key: 'signature_employee', field_type: 'SIGNATURE', binding_key: null, signer_role: 'employee', required: true, page_number: 0, x: 72, y: 600, width: 200, height: 40, ordinal: 0 }],
              variables: [],
              issues: [],
              previewed: false,
              field_import: {
                fields: [{ field_key: 'signature_employee', field_type: 'SIGNATURE', binding_key: null, signer_role: 'employee', required: true, page_number: 0, x: 72, y: 600, width: 200, height: 40, ordinal: 0, source: 'text_tag', source_name: 'signature:Employee' }],
                warnings: [{ code: 'text_tag_type_unknown', message: 'unknown', name: 'stamp:Employee', page_number: 0 }],
                stripped: ['/AcroForm', '/JavaScript'],
              },
            },
          };
        },
      },
    ],
  });
  await expect(page.getByTestId('ffs-opt-import_fields')).not.toBeChecked();
  await expect(page.getByTestId('ffs-opt-apply_text_tags')).not.toBeChecked();
  await page.getByTestId('ffs-opt-import_fields').check();
  await page.getByTestId('ffs-opt-apply_text_tags').check();
  await page.getByTestId('ffs-upload-input').setInputFiles({ name: 'minutes.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdf, 'base64') });
  await expect(page.getByTestId('ffs-import-summary')).toHaveText('1 field added · 1 warning · active content removed');
  await expect(page.getByTestId('ffs-import-warnings')).toContainText('A tag names a field type we don’t know, so it was left as text. (stamp:Employee, page 1)');
  await expect(page.getByTestId('ffs-import-stripped')).toContainText('/AcroForm, /JavaScript');
  expect(uploads).toHaveLength(1);
  expect(uploads[0]).toMatchObject({ import_fields: true, apply_text_tags: true });
  await expect(page.getByTestId('ffs-field-signature_employee')).toBeVisible();
  // The text-tag help is one click away.
  await page.getByTestId('ffs-text-tag-help').locator('summary').click();
  await expect(page.getByTestId('ffs-text-tag-help')).toContainText('{{signature:Seller}}');
});

test('P2-4 · Find fields: ghosts of the palette types; Accept all is one undo step and the fields are saved', async ({ page }) => {
  const layouts: Array<{ fields?: Array<Record<string, unknown>> }> = [];
  await openFixedFormStudio(page, FX, {
    overrides: [
      { path: new RegExp(`^/platform/document-templates/versions/${VERSION}/fixed-form/field-suggestions$`), reply: { body: SUGGESTIONS } },
      {
        method: 'PUT',
        path: new RegExp(`^/platform/document-templates/versions/${VERSION}/fixed-form/layout$`),
        reply: ({ body }) => {
          layouts.push(body as { fields?: Array<Record<string, unknown>> });
          return undefined;
        },
      },
    ],
  });
  await page.getByTestId('ffs-find-fields').click();
  await expect(ghosts(page)).toHaveCount(3);
  await expect(page.getByTestId('ffs-suggestions-count')).toContainText('3 suggested fields');

  // Dismiss one from the keyboard, then accept the rest at once.
  await page.getByTestId('ffs-ghost-form:2').focus();
  await page.keyboard.press('Delete');
  await expect(ghosts(page)).toHaveCount(2);
  await page.getByTestId('ffs-accept-all').click();
  await expect(fields(page)).toHaveCount(2);
  await expect(ghosts(page)).toHaveCount(0);
  await expect(page.getByTestId('ffs-announce')).toContainText('Accepted every suggestion: 2 fields added for Employee.');

  // One undo removes both and brings the ghosts back; redo adds them again.
  await page.getByTestId('ffs-undo').click();
  await expect(fields(page)).toHaveCount(0);
  await expect(ghosts(page)).toHaveCount(2);
  await page.getByTestId('ffs-redo').click();
  await expect(fields(page)).toHaveCount(2);

  // Autosave sends them as ordinary fields for the role.
  await expect.poll(() => layouts.at(-1)?.fields?.length ?? 0).toBe(2);
  expect(layouts.at(-1)?.fields).toEqual([
    expect.objectContaining({ field_key: 'signature_1', field_type: 'SIGNATURE', signer_role: 'employee', x: 72, y: 100, width: 230, height: 50 }),
    expect.objectContaining({ field_key: 'text_1', field_type: 'TEXT', signer_role: 'employee', x: 72, y: 500, width: 300, height: 22 }),
  ]);
});
