// Real PDF pages (directive §2, §6; handoff §4.4/§4.5) rendered natively with
// react-native-pdf (PDFKit / PdfiumAndroid). Each page is its own single-page view sized
// to the screen width, so field overlays can be placed in PDF-point geometry:
// page_number 0-based, points, bottom-left origin — identical to the web editor.
//
// Page geometry comes from the PDF itself: each page's MediaBox in PDF points, read by
// readPdfPageSizes() (the same source the sender editor uses). react-native-pdf's
// onLoadComplete `size` is NOT used for geometry: it is an on-screen size (iOS row size;
// Android page 0 only, scaled), so overlays placed from it land in the wrong place on
// non-Letter pages and on any page whose size differs from page 0.
//
// The renderer gets a file:// URI in the app's own temp folder, deleted when this view
// closes (M-A7 §4 R-7, security/useLocalPdf.ts); it never writes its own cache copy.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import Pdf, { type Source } from 'react-native-pdf';

import { useLocalPdf, type LocalPdfSource } from '../../security/useLocalPdf';
import { useTheme } from '../../theme';
import { base64Decode } from '../../util/bytes';
import type { PageSize } from '../editor/geometry';
import { readPdfPageSizes } from '../editor/pdfPageSizes';

export interface PageLayout {
  /** Displayed width / height in dp. */
  readonly width: number;
  readonly height: number;
  /** dp per PDF point. */
  readonly scale: number;
  /** Page size in PDF points. */
  readonly pageWidth: number;
  readonly pageHeight: number;
}

export type PdfSource = LocalPdfSource;

/** The displayed layout of a page of `size` PDF points fitted to `width` dp. */
export function pageLayoutFor(size: PageSize, width: number): PageLayout {
  const scale = width / size.width;
  return {
    width,
    height: size.height * scale,
    scale,
    pageWidth: size.width,
    pageHeight: size.height,
  };
}

/** MediaBox sizes of a base64 PDF, or null when they can't be read. */
export function pageSizesFromBase64(base64: string): PageSize[] | null {
  try {
    const sizes = readPdfPageSizes(base64Decode(base64));
    return sizes.length > 0 && sizes.every((p) => p.width > 0 && p.height > 0) ? sizes : null;
  } catch {
    return null;
  }
}

/** A PDF-point box (bottom-left origin) to a top-left dp rectangle on the displayed page. */
export function boxOnPage(
  f: { x: number; y: number; width: number | null; height: number | null },
  layout: PageLayout,
  fallback: readonly [number, number] = [160, 24],
): { left: number; top: number; width: number; height: number } {
  const w = f.width ?? fallback[0];
  const h = f.height ?? fallback[1];
  return {
    left: f.x * layout.scale,
    top: (layout.pageHeight - f.y - h) * layout.scale,
    width: w * layout.scale,
    height: h * layout.scale,
  };
}

export interface PdfPagesProps {
  readonly source: PdfSource;
  readonly width: number;
  readonly title: string;
  /** Overlay for 0-based page `index`. */
  readonly renderOverlay?: (index: number, layout: PageLayout) => ReactNode;
  readonly onPageLayout?: (index: number, y: number) => void;
  readonly onError?: () => void;
}

function PdfPage({
  source,
  index,
  width,
  title,
  pointSize,
  onPages,
  renderOverlay,
  onLayoutY,
  onError,
}: {
  /** Null while the document file is being prepared. */
  readonly source: Source | null;
  readonly index: number;
  readonly width: number;
  readonly title: string;
  /** MediaBox size in PDF points; null when unknown (display only, no overlays). */
  readonly pointSize: PageSize | null;
  readonly onPages?: (n: number) => void;
  readonly renderOverlay?: PdfPagesProps['renderOverlay'];
  readonly onLayoutY?: (y: number) => void;
  readonly onError?: () => void;
}) {
  const t = useTheme();
  // Without MediaBox geometry, the on-screen size only sets the aspect ratio for display.
  const [shown, setShown] = useState<{ width: number; height: number } | null>(null);
  const layout: PageLayout | null = pointSize ? pageLayoutFor(pointSize, width) : null;
  const height = layout
    ? layout.height
    : shown
      ? (shown.height / shown.width) * width
      : width * 1.294; // US Letter until measured
  return (
    <View
      onLayout={(e) => onLayoutY?.(e.nativeEvent.layout.y)}
      style={[styles.page, { width, height, backgroundColor: t.color.white }]}
    >
      <View
        style={StyleSheet.absoluteFill}
        accessible
        accessibilityRole="image"
        accessibilityLabel={`${title}, page ${index + 1}`}
      >
        {source ? (
          <Pdf
            source={source}
            page={index + 1}
            singlePage
            scrollEnabled={false}
            enableDoubleTapZoom={false}
            enableAnnotationRendering
            fitPolicy={0}
            trustAllCerts={false}
            style={StyleSheet.absoluteFill}
            renderActivityIndicator={() => <ActivityIndicator color={t.color.accent} />}
            onLoadComplete={(n, _path, s) => {
              if (!pointSize && s && s.width > 0 && s.height > 0)
                setShown({ width: s.width, height: s.height });
              onPages?.(n);
            }}
            onError={() => onError?.()}
          />
        ) : (
          <View style={styles.preparing}>
            <ActivityIndicator color={t.color.accent} />
          </View>
        )}
      </View>
      {layout && renderOverlay ? (
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          {renderOverlay(index, layout)}
        </View>
      ) : null}
    </View>
  );
}

/** Every page of one document on the backdrop, 12 dp apart, fitted to `width`. */
export function PdfPages({
  source,
  width,
  title,
  renderOverlay,
  onPageLayout,
  onError,
}: PdfPagesProps) {
  const t = useTheme();
  const [pages, setPages] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const local = useLocalPdf(source);
  const src: Source | null = local.status === 'ready' ? { uri: local.uri, cache: false } : null;
  const prepareFailed = local.status === 'failed';
  useEffect(() => {
    if (prepareFailed) onError?.();
    // Report once per failure, not on every new onError identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prepareFailed]);
  const sizes = useMemo(
    () => (source.kind === 'base64' ? pageSizesFromBase64(source.base64) : null),
    [source],
  );
  if (failed || prepareFailed) {
    return (
      <View style={[styles.failed, { width }]}>
        <Text style={{ color: t.color.textSecondary, textAlign: 'center' }}>
          This document couldn’t be shown. Check your connection and try again.
        </Text>
      </View>
    );
  }
  if (renderOverlay && !sizes) {
    // Fields can't be placed without the real page geometry: never guess their position.
    return (
      <View style={[styles.failed, { width }]} testID="pdf-geometry-unavailable">
        <Text style={{ color: t.color.textSecondary, textAlign: 'center' }}>
          This document can’t be shown for signing here. Open the link in your email in a browser to
          sign it.
        </Text>
      </View>
    );
  }
  const count = sizes?.length ?? pages ?? 1;
  return (
    <View style={styles.stack}>
      {Array.from({ length: count }, (_, i) => (
        <PdfPage
          key={i}
          source={src}
          index={i}
          width={width}
          title={title}
          pointSize={sizes?.[i] ?? null}
          {...(i === 0 && !sizes ? { onPages: (n: number) => setPages(Math.max(1, n)) } : {})}
          {...(renderOverlay ? { renderOverlay } : {})}
          onLayoutY={(y) => onPageLayout?.(i, y)}
          onError={() => {
            setFailed(true);
            onError?.();
          }}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 12 },
  page: { overflow: 'hidden', alignSelf: 'center' },
  failed: { padding: 24, alignSelf: 'center' },
  preparing: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
