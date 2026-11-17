import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PdfDocument, findOnPage } from './pdf-view';
import type { SignField } from './sign-api';

// UAT SIG-03 — an on-page check box is the box itself (no "Check" badge spilling over
// its caption or the neighbouring box), and tapping its caption toggles that box.

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));
// A 612×792 page; PDF y is bottom-up, the viewport top-down (as pdf.js converts it).
// Page 1 says "Terms", page 2 says "Signature schedule" (UAT SIG-16 find).
const { viewport, TEXT } = vi.hoisted(() => ({
  viewport: { width: 612, height: 792, convertToViewportRectangle: ([x1 = 0, y1 = 0, x2 = 0, y2 = 0]: number[]) => [x1, 792 - y1, x2, 792 - y2] },
  TEXT: { 1: 'Terms of service', 2: 'Signature schedule' } as Record<number, string>,
}));
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 2,
      getPage: async (n: number) => ({
        getViewport: () => viewport,
        render: () => ({ promise: Promise.resolve(), cancel: () => undefined }),
        getTextContent: async () => ({ items: [{ str: TEXT[n] ?? '', transform: [12, 0, 0, 12, 72, 700], width: 100, height: 12 }] }),
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

describe('Find in the document (UAT SIG-16)', () => {
  it('findOnPage boxes a matching run in page percentages, case-insensitively', () => {
    const hits = findOnPage(1, [{ str: 'Signature schedule', transform: [12, 0, 0, 12, 72, 700], width: 100, height: 12 }, { str: 'other', transform: [1, 0, 0, 1, 0, 0], width: 5 }], viewport, '  SCHEDULE ');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ page: 1 });
    expect(hits[0]!.left).toBeCloseTo((72 / 612) * 100);
    expect(hits[0]!.top).toBeCloseTo(((792 - 712) / 792) * 100);
    expect(findOnPage(0, [{ str: 'x', transform: [1, 0, 0, 1, 0, 0] }], viewport, '   ')).toEqual([]);
  });

  it('finds the word on page 2, says "1 of 1" and highlights it there', async () => {
    show(() => undefined);
    fireEvent.click(await screen.findByTestId('sg-find-open'));
    fireEvent.change(screen.getByTestId('sg-find-input'), { target: { value: 'signature' } });
    fireEvent.click(screen.getByTestId('sg-find-go'));
    expect(await screen.findByTestId('sg-find-count')).toHaveTextContent('1 of 1');
    const pages = screen.getAllByLabelText(/^Page \d$/);
    expect(pages[1]!.querySelector('.sg-find__hit--on')).not.toBeNull();
    expect(pages[0]!.querySelector('.sg-find__hit')).toBeNull();
  });

  it('a word that is not there says "No matches"', async () => {
    show(() => undefined);
    fireEvent.click(await screen.findByTestId('sg-find-open'));
    fireEvent.change(screen.getByTestId('sg-find-input'), { target: { value: 'zebra' } });
    fireEvent.click(screen.getByTestId('sg-find-go'));
    expect(await screen.findByTestId('sg-find-count')).toHaveTextContent('No matches');
  });
});
