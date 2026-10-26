// One PDF page rendered natively (react-native-pdf: PDFKit / PdfiumAndroid, directive
// §2) at a fixed width, with an overlay in the same frame. The page's size in points
// comes from the PDF itself (pdfPageSizes.ts) or the upload response — not from the
// renderer, whose reported size is the on-screen size. Height = width × (h / w), so
// overlay pixels map to points by one scale factor (geometry.ts scaleFor).
import { memo, type ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import Pdf from 'react-native-pdf';

import { useTheme } from '../../theme';
import type { PageSize } from './geometry';

export interface PdfPageViewProps {
  readonly base64: string;
  /** 0-based. */
  readonly pageIndex: number;
  readonly page: PageSize;
  /** Rendered width in dp. */
  readonly width: number;
  readonly highlighted?: boolean;
  readonly label: string;
  readonly children?: ReactNode;
  readonly onError?: () => void;
}

function PdfPageViewImpl({
  base64,
  pageIndex,
  page,
  width,
  highlighted,
  label,
  children,
  onError,
}: PdfPageViewProps) {
  const t = useTheme();
  const height = (width * page.height) / page.width;
  return (
    <View
      style={[styles.page, { width, height, backgroundColor: t.color.white }]}
      accessibilityLabel={label}
    >
      <View
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
        importantForAccessibility="no-hide-descendants"
      >
        <Pdf
          source={{ uri: `data:application/pdf;base64,${base64}`, cache: false }}
          page={pageIndex + 1}
          singlePage
          scrollEnabled={false}
          enableDoubleTapZoom={false}
          enableAnnotationRendering
          fitPolicy={0}
          trustAllCerts={false}
          style={StyleSheet.absoluteFill}
          renderActivityIndicator={() => <ActivityIndicator color={t.color.accent} />}
          onError={() => onError?.()}
        />
      </View>
      {children}
      {highlighted ? (
        // The "tool picked" outline (handoff §4.6) is drawn on top, so it never shifts
        // the page content under the overlay.
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { borderColor: t.color.accent, borderWidth: 2 }]}
        />
      ) : null}
    </View>
  );
}

export const PdfPageView = memo(PdfPageViewImpl);

const styles = StyleSheet.create({
  page: { overflow: 'hidden', alignSelf: 'center' },
});
