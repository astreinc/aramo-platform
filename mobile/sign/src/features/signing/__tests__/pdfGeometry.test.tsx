// Field overlays are placed from each page's own MediaBox (PDF points, bottom-left
// origin) — never from react-native-pdf's on-screen size — and stay aligned under zoom.
import { render, screen } from '@testing-library/react-native';
import { StyleSheet, View } from 'react-native';

import { boxOnPage, pageLayoutFor, pageSizesFromBase64, PdfPages } from '../PdfPages';
import { clampZoom, zoomedBox, ZoomFrame } from '../ZoomablePages';

// The native renderer reports a misleading on-screen size (Letter-like, page 0 only).
jest.mock('react-native-pdf', () => {
  const { View: RNView } = jest.requireActual('react-native');
  return function Pdf(props: {
    onLoadComplete?: (n: number, p: string, s: { width: number; height: number }) => void;
  }) {
    props.onLoadComplete?.(1, '', { width: 390, height: 505 });
    return <RNView testID="pdf" />;
  };
});
jest.setTimeout(30_000);

function pdfBase64(boxes: string[]): string {
  const kids = boxes.map((_, i) => `${i + 3} 0 R`).join(' ');
  const pages = boxes.map(
    (b, i) => `${i + 3} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [${b}] >> endobj`,
  );
  const text = [
    '%PDF-1.7',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    `2 0 obj << /Type /Pages /Kids [${kids}] /Count ${boxes.length} >> endobj`,
    ...pages,
    'trailer << /Root 1 0 R >>',
    '%%EOF',
  ].join('\n');
  return Buffer.from(text, 'latin1').toString('base64');
}

const A4 = '0 0 595.28 841.89';
const LETTER = '0 0 612 792';
const A4_LANDSCAPE = '0 0 841.89 595.28';
const WIDTH = 300;
const FIELD = { x: 100, y: 500, width: 200, height: 50 };

function flat(testID: string) {
  return StyleSheet.flatten(screen.getByTestId(testID).props.style) as {
    left: number;
    top: number;
    width: number;
    height: number;
  };
}

function overlayAt(page: number) {
  return function renderOverlay(index: number, layout: ReturnType<typeof pageLayoutFor>) {
    return index === page ? (
      <View
        testID={`overlay-${index}`}
        style={{ position: 'absolute', ...boxOnPage(FIELD, layout) }}
      />
    ) : null;
  };
}

describe('page geometry from the MediaBox', () => {
  it('reads every page’s own size in PDF points', () => {
    expect(pageSizesFromBase64(pdfBase64([LETTER, A4_LANDSCAPE]))).toEqual([
      { width: 612, height: 792 },
      { width: 841.89, height: 595.28 },
    ]);
    expect(pageSizesFromBase64('bm90IGEgcGRm')).toBeNull();
  });

  it('A4: a field at known PDF points lands at the right screen position', async () => {
    render(
      <PdfPages
        source={{ kind: 'base64', base64: pdfBase64([A4]) }}
        width={WIDTH}
        title="Doc"
        renderOverlay={overlayAt(0)}
      />,
    );
    const s = WIDTH / 595.28;
    const box = flat('overlay-0');
    expect(box.left).toBeCloseTo(100 * s, 6);
    expect(box.top).toBeCloseTo((841.89 - 500 - 50) * s, 6);
    expect(box.width).toBeCloseTo(200 * s, 6);
    expect(box.height).toBeCloseTo(50 * s, 6);
  });

  it('page 2 of a mixed-size document uses page 2’s size, not page 0’s', () => {
    render(
      <PdfPages
        source={{ kind: 'base64', base64: pdfBase64([LETTER, A4_LANDSCAPE]) }}
        width={WIDTH}
        title="Doc"
        renderOverlay={overlayAt(1)}
      />,
    );
    expect(screen.getAllByTestId('pdf')).toHaveLength(2);
    const s = WIDTH / 841.89;
    const box = flat('overlay-1');
    expect(box.left).toBeCloseTo(100 * s, 6);
    expect(box.top).toBeCloseTo((595.28 - 500 - 50) * s, 6);
    // The page view itself is sized from the MediaBox aspect ratio.
    expect(pageLayoutFor({ width: 841.89, height: 595.28 }, WIDTH).height).toBeCloseTo(
      595.28 * s,
      6,
    );
  });

  it('never guesses field positions when the geometry can’t be read', () => {
    render(
      <PdfPages
        source={{ kind: 'base64', base64: 'bm90IGEgcGRm' }}
        width={WIDTH}
        title="Doc"
        renderOverlay={overlayAt(0)}
      />,
    );
    expect(screen.getByTestId('pdf-geometry-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('overlay-0')).toBeNull();
  });
});

describe('zoom keeps fields aligned (D-11)', () => {
  const layout = pageLayoutFor({ width: 595.28, height: 841.89 }, WIDTH);
  const base = boxOnPage(FIELD, layout);

  it.each([1, 1.5, 2])('at %s the overlay stays proportional to the page', (z) => {
    const box = zoomedBox(base, z);
    const page = { width: layout.width * z, height: layout.height * z };
    expect(box.left / page.width).toBeCloseTo(base.left / layout.width, 9);
    expect(box.top / page.height).toBeCloseTo(base.top / layout.height, 9);
    expect(box.width / page.width).toBeCloseTo(base.width / layout.width, 9);
    expect(box.height / page.height).toBeCloseTo(base.height / layout.height, 9);
  });

  it.each([1, 1.5, 2])('at %s pages and overlays share one transform', (z) => {
    render(
      <ZoomFrame zoom={z}>
        <View testID="page" style={{ width: layout.width, height: layout.height }}>
          <View testID="field" style={{ position: 'absolute', ...base }} />
        </View>
      </ZoomFrame>,
    );
    const content = StyleSheet.flatten(screen.getByTestId('zoom-content').props.style) as {
      transform: { scale: number }[];
      transformOrigin: string;
    };
    expect(content.transform).toEqual([{ scale: z }]);
    expect(content.transformOrigin).toBe('top left');
    // The field is a child of the transformed container (it scales with the page).
    const field = screen.getByTestId('field');
    let node = field.parent;
    let inside = false;
    while (node) {
      if (node.props.testID === 'zoom-content') inside = true;
      node = node.parent;
    }
    expect(inside).toBe(true);
  });

  it('clamps zoom to 1…3', () => {
    expect(clampZoom(0.5)).toBe(1);
    expect(clampZoom(5)).toBe(3);
    expect(clampZoom(Number.NaN)).toBe(1);
  });
});
