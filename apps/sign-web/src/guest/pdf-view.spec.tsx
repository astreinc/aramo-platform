import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PdfDocument } from './pdf-view';
import type { SignField } from './sign-api';

// UAT SIG-03 — an on-page check box is the box itself (no "Check" badge spilling over
// its caption or the neighbouring box), and tapping its caption toggles that box.

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({
        getViewport: () => ({ width: 612, height: 792 }),
        render: () => ({ promise: Promise.resolve(), cancel: () => undefined }),
      }),
      destroy: async () => undefined,
    }),
  }),
}));

const box = (id: string, label: string, y: number): SignField =>
  ({ field_id: id, document_id: 'd1', field_type: 'CHECKBOX', page_number: 0, x: 86, y, width: 14, height: 14, required: true, filled: false, value: null, label }) as SignField;
const sig: SignField = { field_id: 's1', document_id: 'd1', field_type: 'SIGNATURE', page_number: 0, x: 86, y: 300, width: 160, height: 30, required: true, filled: false, value: null } as SignField;

function show(onField: (f: SignField) => void, checked: readonly string[] = []) {
  render(
    <PdfDocument
      base64=""
      fields={[box('yes', 'Yes', 570), box('no', 'No', 541), sig]}
      display={(f) => (checked.includes(f.field_id) ? { kind: 'mark', value: '✓' } : null)}
      activeField={null}
      label={(f) => f.label ?? f.field_type}
      actionLabel={(f) => (f.field_type === 'CHECKBOX' ? 'Check' : 'Sign')}
      onField={onField}
      onError={() => undefined}
    />,
  );
}

describe('on-page check box (UAT SIG-03)', () => {
  it('has no "Check" badge; other fields keep their badge', async () => {
    show(() => undefined);
    const fields = await screen.findAllByTestId('sg-onpage-field');
    const [yes, no, signature] = fields;
    expect(yes).toHaveClass('sg-onpage--box');
    expect(yes).not.toHaveTextContent('Check');
    expect(no).not.toHaveTextContent('Check');
    expect(signature).toHaveTextContent('Sign');
    expect(signature).not.toHaveClass('sg-onpage--box');
  });

  it('tapping the caption toggles that box, not its neighbour', async () => {
    const onField = vi.fn();
    show(onField);
    const captions = await screen.findAllByTestId('sg-onpage-caption');
    const no = captions[1];
    if (no === undefined) throw new Error('no caption');
    fireEvent.click(no);
    expect(onField).toHaveBeenCalledTimes(1);
    expect(onField).toHaveBeenCalledWith(expect.objectContaining({ field_id: 'no' }));
  });

  it('a checked box shows the check mark', async () => {
    show(() => undefined, ['yes']);
    const [yes] = await screen.findAllByTestId('sg-onpage-field');
    expect(yes).toHaveClass('sg-onpage--done');
    expect(yes).toHaveTextContent('✓');
  });
});
