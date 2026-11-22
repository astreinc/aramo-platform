// FIELD-PARITY-1 §6 Phase 3 (Sign Field Placement Enterprise Parity Directive v1.0 LOCKED; §8
// item 6 "console Studio fixed-form journeys") — in the console's fixed-form Studio (the shared
// placement editor): place a DROPDOWN and edit its choices, a RADIO set of two options ("Add
// option"), and a NUMBER money field; the autosave PUT carries every setting, and after a reload
// the Studio shows them again. The layout route here keeps what was saved (a stateful mock), so
// the reload reads the saved fields back.

import { expect, test } from '@playwright/test';

import { fixedFormMock, fixedFormPdf, openFixedFormStudio } from '../fixtures/fixed-form';

interface SavedField {
  readonly field_key: string;
  readonly field_type: string;
  readonly label?: string | null;
  readonly group_key?: string | null;
  readonly options?: unknown;
}

test('P3 · DROPDOWN with choices, a RADIO set and a NUMBER money field save and come back after a reload', async ({ page }) => {
  const templateId = 'dt_ffp3types';
  const versionId = `${templateId}_v1`;
  const fx = { templateId, title: 'Order form', pages: 1 };
  // The fixture's own view of the draft (its GET route's body), to answer with the saved fields.
  const viewPath = new RegExp(`^/platform/document-templates/versions/${versionId}/fixed-form$`);
  const baseView = fixedFormMock(fx, await fixedFormPdf(fx.pages)).overrides?.find((o) => o.path.source === viewPath.source)?.reply as { body: Record<string, unknown> };
  let saved: SavedField[] = [];
  let signing: unknown = undefined;
  // Checked before the fixture's own routes: the layout PUT keeps the fields, the view returns them.
  const overrides = [
    {
      method: 'GET',
      path: viewPath,
      reply: () =>
        saved.length === 0
          ? undefined
          : { body: { ...baseView.body, fields: saved, issues: [], ...(signing !== undefined ? { content: { ...(baseView.body['content'] as object), signing } } : {}) } },
    },
    {
      method: 'PUT',
      path: new RegExp(`^/platform/document-templates/versions/${versionId}/fixed-form/layout$`),
      reply: ({ body }: { body: unknown }) => {
        const b = body as { fields?: SavedField[]; signing?: unknown };
        saved = b.fields ?? [];
        signing = b.signing ?? signing;
        return undefined;
      },
    },
  ];
  await openFixedFormStudio(page, fx, { overrides });

  // DROPDOWN: two starting choices; add a third and name it.
  await page.getByTestId('ffs-add-DROPDOWN').click();
  await page.getByTestId('ffs-field-dropdown_1').click();
  await expect(page.getByTestId('ffs-choice-label-1')).toHaveValue('Option 2');
  await page.getByTestId('ffs-choice-add').click();
  await page.getByTestId('ffs-choice-label-2').fill('Express');
  await page.getByTestId('ffs-choice-value-2').fill('express');

  // RADIO set: one option, then "Add option" for a second in the same group.
  await page.getByTestId('ffs-add-RADIO').click();
  await page.getByTestId('ffs-field-radio_1').click();
  await page.getByTestId('ffs-label').fill('Pickup');
  await page.getByTestId('ffs-radio-add').click();
  await expect(page.getByTestId('ffs-radio-count')).toHaveText(/2 options in this group/);
  await page.getByTestId('ffs-label').fill('Delivery');

  // NUMBER money field.
  await page.getByTestId('ffs-add-NUMBER').click();
  await page.getByTestId('ffs-field-number_1').click();
  await page.getByTestId('ffs-number-format-select').selectOption('money');
  await expect(page.getByTestId('ffs-number-currency')).toHaveValue('USD');

  await expect(page.getByTestId('ffs-save-state')).toHaveText('Saved');
  await expect.poll(() => saved.length).toBe(4);
  const byKey = new Map(saved.map((f) => [f.field_key, f]));
  expect(byKey.get('dropdown_1')?.options).toEqual({
    choices: [
      { value: 'Option 1', label: 'Option 1' },
      { value: 'Option 2', label: 'Option 2' },
      { value: 'express', label: 'Express' },
    ],
  });
  expect(byKey.get('radio_1')).toMatchObject({ field_type: 'RADIO', label: 'Pickup', group_key: 'radio_1' });
  expect(byKey.get('radio_2')).toMatchObject({ field_type: 'RADIO', label: 'Delivery', group_key: 'radio_1' });
  expect(byKey.get('number_1')?.options).toEqual({ format: 'money', currency: 'USD', decimals: 2 });

  // Reload: the view now returns the saved fields.
  await page.reload();
  await expect(page.getByTestId('fixed-form-studio')).toBeVisible();
  await page.getByTestId('ffs-field-dropdown_1').click();
  await expect(page.getByTestId('ffs-choice-label-2')).toHaveValue('Express');
  await page.getByTestId('ffs-field-radio_2').click();
  await expect(page.getByTestId('ffs-label')).toHaveValue('Delivery');
  await expect(page.getByTestId('ffs-radio-count')).toHaveText(/2 options in this group/);
  await page.getByTestId('ffs-field-number_1').click();
  await expect(page.getByTestId('ffs-number-format-select')).toHaveValue('money');
});
