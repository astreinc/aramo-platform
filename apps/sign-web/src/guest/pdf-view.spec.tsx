import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { TextLayer } from './find';
import { PdfDocument } from './pdf-view';
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

// UAT SIG-16 retest — the server's word boxes (page fractions, top-left) for Find.
const LAYER: TextLayer = {
  document_id: 'd1',
  pages: [
    { page: 1, words: [{ t: 'Terms', x: 0.1, y: 0.1, w: 0.1, h: 0.02 }, { t: 'citizen-facing', x: 0.3, y: 0.1, w: 0.2, h: 0.02 }] },
    { page: 2, words: [{ t: 'Signature', x: 0.12, y: 0.2, w: 0.15, h: 0.02 }, { t: 'schedule', x: 0.3, y: 0.2, w: 0.12, h: 0.02 }, { t: 'Signature', x: 0.12, y: 0.5, w: 0.15, h: 0.02 }] },
  ],
};

function show(onField: (f: SignField) => void, checked: readonly string[] = [], loadTextLayer: (() => Promise<TextLayer>) | null = async () => LAYER) {
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
      loadTextLayer={loadTextLayer ?? undefined}
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

  it('draws no label beside the box (PO 2026-11-25); the label is its name and hover title', async () => {
    const onField = vi.fn();
    show(onField);
    const [yes, no] = await screen.findAllByTestId('sg-onpage-field');
    expect(screen.queryAllByTestId('sg-onpage-caption')).toHaveLength(0);
    if (no === undefined || yes === undefined) throw new Error('no boxes');
    expect(no.textContent).toBe('');
    expect(no.getAttribute('aria-label')).toMatch(/No/);
    expect(no.getAttribute('title')).toMatch(/^No/);
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

describe('Find in the document (UAT SIG-16, retest web ≡ app)', () => {
  const find = async (q: string) => {
    fireEvent.click(await screen.findByTestId('sg-find-open'));
    fireEvent.change(screen.getByTestId('sg-find-input'), { target: { value: q } });
    fireEvent.click(screen.getByTestId('sg-find-go'));
  };

  it('finds a word inside a hyphenated word ("citizen" in "citizen-facing"), as the app', async () => {
    show(() => undefined);
    await find('citizen');
    expect(await screen.findByTestId('sg-find-count')).toHaveTextContent('1 of 1');
  });

  it('highlights only the matched word box, on its page', async () => {
    show(() => undefined);
    await find('schedule');
    expect(await screen.findByTestId('sg-find-count')).toHaveTextContent('1 of 1');
    const pages = screen.getAllByLabelText(/^Page \d$/);
    const on = pages[1]!.querySelector<HTMLElement>('.sg-find__hit--on');
    expect(on).not.toBeNull();
    expect(on!.style.left).toBe('30%');
    expect(on!.style.width).toBe('12%');
    expect(pages[0]!.querySelector('.sg-find__hit')).toBeNull();
  });

  it('Enter again and › step to the next match; ‹ goes back (wrapping)', async () => {
    show(() => undefined);
    await find('signature');
    expect(await screen.findByTestId('sg-find-count')).toHaveTextContent('1 of 2');
    fireEvent.click(screen.getByTestId('sg-find-go'));
    expect(await screen.findByTestId('sg-find-count')).toHaveTextContent('2 of 2');
    fireEvent.click(screen.getByTestId('sg-find-next'));
    expect(await screen.findByTestId('sg-find-count')).toHaveTextContent('1 of 2');
    fireEvent.click(screen.getByTestId('sg-find-prev'));
    expect(await screen.findByTestId('sg-find-count')).toHaveTextContent('2 of 2');
  });

  it('says "No matches", and asks for 2 letters, as the app', async () => {
    show(() => undefined);
    await find('zebra');
    expect(await screen.findByTestId('sg-find-count')).toHaveTextContent('No matches');
    fireEvent.change(screen.getByTestId('sg-find-input'), { target: { value: 'z' } });
    fireEvent.click(screen.getByTestId('sg-find-go'));
    expect(await screen.findByTestId('sg-find-count')).toHaveTextContent('Type at least 2 letters');
  });

  it('a failed text layer says it could not search', async () => {
    show(() => undefined, [], async () => Promise.reject(new Error('net')));
    await find('terms');
    expect(await screen.findByTestId('sg-find-count')).toHaveTextContent('Couldn’t search this document');
  });

  it('no Find without a text layer loader', async () => {
    show(() => undefined, [], null);
    await screen.findAllByLabelText(/^Page \d$/);
    expect(screen.queryByTestId('sg-find-open')).toBeNull();
  });
});
