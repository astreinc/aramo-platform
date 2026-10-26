// Pinch-to-zoom for document pages with fields staying aligned (handoff §4.4; directive
// §6; D-11), on both platforms.
//   - iOS: the native UIScrollView zoom (maximumZoomScale), which scales the pages and
//     their overlays together.
//   - Android: ScrollView has no zoom, so a gesture-handler pinch drives a scale
//     transform on ONE container holding the pages AND their overlays (origin top-left),
//     inside vertical + horizontal scroll views sized to the scaled content. Overlays are
//     children of the transformed container, so they scale with the page exactly.
// Reduced motion: zoom follows the fingers only; nothing animates.
import { forwardRef, useState, type ReactNode } from 'react';
import {
  Platform,
  ScrollView,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 3;

export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return MIN_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/** Where a box drawn at zoom 1 appears at `zoom` (transform origin top-left). */
export function zoomedBox(
  box: { left: number; top: number; width: number; height: number },
  zoom: number,
): { left: number; top: number; width: number; height: number } {
  return {
    left: box.left * zoom,
    top: box.top * zoom,
    width: box.width * zoom,
    height: box.height * zoom,
  };
}

/**
 * The transformed frame (Android path), exported for tests: children are laid out at
 * zoom 1 and scaled from the top-left, and the outer frame takes the scaled size so the
 * scroll views can reach every part of the page.
 */
export function ZoomFrame({
  zoom,
  children,
}: {
  readonly zoom: number;
  readonly children: ReactNode;
}) {
  const [base, setBase] = useState<{ width: number; height: number } | null>(null);
  const z = clampZoom(zoom);
  return (
    <View
      testID="zoom-frame"
      style={base ? { width: base.width * z, height: base.height * z } : null}
    >
      <View
        testID="zoom-content"
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          if (!base || base.width !== width || base.height !== height) setBase({ width, height });
        }}
        style={[
          // Width fixed at the zoom-1 width; height follows the content (pages load).
          base ? [styles.abs, { width: base.width }] : null,
          { transform: [{ scale: z }], transformOrigin: 'top left' },
        ]}
      >
        {children}
      </View>
    </View>
  );
}

export interface ZoomablePagesProps {
  readonly children: ReactNode;
  readonly contentContainerStyle?: StyleProp<ViewStyle>;
  /** Android: the current zoom, so callers can scale scroll targets. */
  readonly onZoomChange?: (zoom: number) => void;
}

export const ZoomablePages = forwardRef<ScrollView, ZoomablePagesProps>(function ZoomablePages(
  { children, contentContainerStyle, onZoomChange },
  ref,
) {
  const [zoom, setZoom] = useState(1);
  const [start, setStart] = useState(1);
  if (Platform.OS === 'ios') {
    return (
      <ScrollView
        ref={ref}
        contentContainerStyle={contentContainerStyle}
        maximumZoomScale={MAX_ZOOM}
        minimumZoomScale={MIN_ZOOM}
        pinchGestureEnabled
      >
        {children}
      </ScrollView>
    );
  }
  const pinch = Gesture.Pinch()
    .runOnJS(true)
    .onStart(() => setStart(zoom))
    .onUpdate((e) => {
      const z = clampZoom(start * e.scale);
      setZoom(z);
      onZoomChange?.(z);
    });
  return (
    <GestureDetector gesture={pinch}>
      <ScrollView ref={ref} scrollEnabled>
        <ScrollView horizontal scrollEnabled={zoom > 1} showsHorizontalScrollIndicator={zoom > 1}>
          <ZoomFrame zoom={zoom}>
            <View style={contentContainerStyle}>{children}</View>
          </ZoomFrame>
        </ScrollView>
      </ScrollView>
    </GestureDetector>
  );
});

const styles = StyleSheet.create({
  abs: { position: 'absolute', top: 0, left: 0 },
});
