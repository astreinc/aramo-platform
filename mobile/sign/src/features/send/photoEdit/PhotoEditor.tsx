// M-A13 #9 — after choosing photos, each one gets a crop / straighten / rotate step
// before the PDF is built (the camera Scan path is unchanged: the scanner crops).
//
// usePhotoEditor() returns `edit` (handed to pickPhotosToPdf) and the modal element the
// caller renders inside its own tree, so on iOS it presents over the sheet it was opened
// from. Each photo resolves to new JPEG bytes, or null when it was left unchanged (the
// original bytes are then used, with no re-encode). Cancel drops the whole selection.
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '../../../components/Button';
import { useTheme } from '../../../theme';
import {
  clampStraighten,
  cropBounds,
  initialEdit,
  isIdentity,
  moveCorner,
  normalizeQuarter,
  stageLayout,
  STRAIGHTEN_LIMIT,
  type Corner,
  type FracRect,
  type PhotoEdit,
  type Size,
} from './photoCrop';
import { nativePhotoEdit, type PhotoEditPort, type PreparedPhoto } from './photoEditNative';

export interface PickedPhoto {
  readonly uri: string;
}

/** Per photo: edited JPEG bytes, or null = unchanged. Null overall = cancelled. */
export type PhotoEditFn = (
  photos: readonly PickedPhoto[],
) => Promise<readonly (Uint8Array | null)[] | null>;

export const PHOTO_EDIT_FAILED = 'This photo couldn’t be edited. Tap Next to add it as it is.';
const CORNER = 28;
const MIN_CROP_PT = 48;

interface Session {
  readonly photos: readonly PickedPhoto[];
  readonly resolve: (r: readonly (Uint8Array | null)[] | null) => void;
}

export function usePhotoEditor(
  port: PhotoEditPort = nativePhotoEdit,
  quality = 0.85,
): { readonly edit: PhotoEditFn; readonly element: ReactElement | null } {
  const [session, setSession] = useState<Session | null>(null);
  const edit = useMemo<PhotoEditFn>(
    () => (photos) =>
      photos.length === 0
        ? Promise.resolve([])
        : new Promise((resolve) => setSession({ photos, resolve })),
    [],
  );
  const element = session ? (
    <PhotoEditModal
      photos={session.photos}
      port={port}
      quality={quality}
      onDone={(r) => {
        setSession(null);
        session.resolve(r);
      }}
    />
  ) : null;
  return { edit, element };
}

function PhotoEditModal({
  photos,
  port,
  quality,
  onDone,
}: {
  readonly photos: readonly PickedPhoto[];
  readonly port: PhotoEditPort;
  readonly quality: number;
  readonly onDone: (r: readonly (Uint8Array | null)[] | null) => void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [index, setIndex] = useState(0);
  const results = useRef<(Uint8Array | null)[]>([]);
  const [prepared, setPrepared] = useState<{ index: number; photo: PreparedPhoto | null } | null>(null);
  const [edit, setEdit] = useState<PhotoEdit>(initialEdit);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [area, setArea] = useState<Size | null>(null);

  // Prepare the current photo (an upright copy; its dimensions drive the geometry).
  useEffect(() => {
    let live = true;
    const uri = photos[index]?.uri;
    if (!uri) return;
    port.prepare(uri).then(
      (photo) => {
        if (live) setPrepared({ index, photo });
        else port.discard(photo.uri);
      },
      () => {
        if (live) setPrepared({ index, photo: null });
      },
    );
    return () => {
      live = false;
    };
  }, [index, photos, port]);
  const current = prepared?.index === index ? prepared.photo : undefined;

  function finishPhoto(bytes: Uint8Array | null): void {
    results.current[index] = bytes;
    if (current) port.discard(current.uri);
    if (index + 1 >= photos.length) {
      onDone(photos.map((_, i) => results.current[i] ?? null));
      return;
    }
    setIndex(index + 1);
    setEdit(initialEdit());
    setNote(null);
  }

  async function next(): Promise<void> {
    if (!current || isIdentity(edit)) {
      finishPhoto(null);
      return;
    }
    setBusy(true);
    try {
      finishPhoto(await port.apply(current, edit, quality));
    } catch {
      // Stay on this photo; Next now adds it unchanged.
      setEdit(initialEdit());
      setNote(PHOTO_EDIT_FAILED);
    } finally {
      setBusy(false);
    }
  }

  function cancel(): void {
    if (current) port.discard(current.uri);
    onDone(null);
  }

  function regeometry(quarter: number, straighten: number): void {
    const q = normalizeQuarter(quarter);
    const s = clampStraighten(straighten);
    setEdit({
      quarter: q,
      straighten: s,
      crop: current ? cropBounds(current, q, s) : { x: 0, y: 0, w: 1, h: 1 },
    });
  }

  const last = index + 1 >= photos.length;
  return (
    <Modal visible animationType="slide" onRequestClose={cancel} presentationStyle="fullScreen">
      {/* Modal content is its own root: it needs its own gesture-handler root. */}
      <GestureHandlerRootView
        testID="photo-edit"
        style={[styles.fill, { backgroundColor: '#000000', paddingTop: insets.top, paddingBottom: insets.bottom }]}
      >
        <View style={styles.bar}>
          <Button title="Cancel" variant="text" onPress={cancel} testID="photo-edit-cancel" />
          <Text accessibilityRole="header" style={[styles.title, { fontFamily: t.font.family }]}>
            {photos.length > 1 ? `Photo ${index + 1} of ${photos.length}` : 'Edit photo'}
          </Text>
          <Button
            title={last ? 'Done' : 'Next'}
            variant="text"
            busy={busy}
            disabled={busy || current === undefined}
            onPress={() => void next()}
            testID="photo-edit-next"
          />
        </View>
        <View
          style={styles.stage}
          onLayout={(e: LayoutChangeEvent) =>
            setArea({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })
          }
        >
          {current === undefined ? (
            <ActivityIndicator color="#FFFFFF" accessibilityLabel="Preparing the photo" />
          ) : current === null ? (
            <Text style={styles.hint}>This photo can’t be edited here. Tap {last ? 'Done' : 'Next'} to add it as it is.</Text>
          ) : area ? (
            <Stage photo={current} edit={edit} area={area} onCrop={(crop) => setEdit((e) => ({ ...e, crop }))} />
          ) : null}
        </View>
        {note ? <Text style={styles.hint} accessibilityRole="alert">{note}</Text> : null}
        {current ? (
          <View style={styles.tools}>
            <StraightenSlider value={edit.straighten} onChange={(s) => regeometry(edit.quarter, s)} />
            <View style={styles.row}>
              <Button
                title="Rotate left"
                variant="text"
                testID="photo-rotate-left"
                onPress={() => regeometry(edit.quarter - 90, edit.straighten)}
              />
              <Button
                title="Reset"
                variant="text"
                testID="photo-reset"
                disabled={isIdentity(edit)}
                onPress={() => setEdit(initialEdit())}
              />
              <Button
                title="Rotate right"
                variant="text"
                testID="photo-rotate-right"
                onPress={() => regeometry(edit.quarter + 90, edit.straighten)}
              />
            </View>
          </View>
        ) : null}
      </GestureHandlerRootView>
    </Modal>
  );
}

function Stage({
  photo,
  edit,
  area,
  onCrop,
}: {
  readonly photo: PreparedPhoto;
  readonly edit: PhotoEdit;
  readonly area: Size;
  readonly onCrop: (crop: FracRect) => void;
}) {
  const layout = stageLayout(photo, edit.quarter, edit.straighten, area);
  const bounds = cropBounds(photo, edit.quarter, edit.straighten);
  const { box } = layout;
  const crop = edit.crop;
  const min = { w: Math.min(bounds.w, MIN_CROP_PT / box.width), h: Math.min(bounds.h, MIN_CROP_PT / box.height) };
  const img = { width: photo.width * layout.scale, height: photo.height * layout.scale };
  const rect = {
    left: crop.x * box.width,
    top: crop.y * box.height,
    width: crop.w * box.width,
    height: crop.h * box.height,
  };
  const turn = edit.quarter + edit.straighten;
  return (
    <View style={{ position: 'absolute', left: layout.left, top: layout.top, width: box.width, height: box.height }}>
      <Image
        source={{ uri: photo.uri }}
        accessibilityIgnoresInvertColors
        style={{
          position: 'absolute',
          left: (box.width - img.width) / 2,
          top: (box.height - img.height) / 2,
          width: img.width,
          height: img.height,
          transform: [{ rotate: `${turn}deg` }],
        }}
      />
      {/* Dim everything outside the crop. */}
      <View pointerEvents="none" style={[styles.shade, { left: 0, top: 0, right: 0, height: rect.top }]} />
      <View pointerEvents="none" style={[styles.shade, { left: 0, top: rect.top + rect.height, right: 0, bottom: 0 }]} />
      <View pointerEvents="none" style={[styles.shade, { left: 0, top: rect.top, width: rect.left, height: rect.height }]} />
      <View
        pointerEvents="none"
        style={[styles.shade, { left: rect.left + rect.width, top: rect.top, right: 0, height: rect.height }]}
      />
      <View pointerEvents="none" testID="photo-crop" style={[styles.frame, rect]} />
      {(['tl', 'tr', 'bl', 'br'] as const).map((c) => (
        <CornerHandle
          key={c}
          corner={c}
          x={c === 'tl' || c === 'bl' ? rect.left : rect.left + rect.width}
          y={c === 'tl' || c === 'tr' ? rect.top : rect.top + rect.height}
          onDrag={(dx, dy) => onCrop(moveCorner(crop, c, dx / box.width, dy / box.height, bounds, min))}
        />
      ))}
    </View>
  );
}

function CornerHandle({
  corner,
  x,
  y,
  onDrag,
}: {
  readonly corner: Corner;
  readonly x: number;
  readonly y: number;
  readonly onDrag: (dx: number, dy: number) => void;
}) {
  const pan = Gesture.Pan()
    .runOnJS(true)
    .minDistance(0)
    .onChange((e) => onDrag(e.changeX, e.changeY));
  return (
    <GestureDetector gesture={pan}>
      <View
        testID={`photo-crop-${corner}`}
        accessibilityLabel="Crop corner"
        style={[styles.handle, { left: x - CORNER / 2, top: y - CORNER / 2 }]}
      >
        <View style={styles.handleDot} />
      </View>
    </GestureDetector>
  );
}

function StraightenSlider({
  value,
  onChange,
}: {
  readonly value: number;
  readonly onChange: (deg: number) => void;
}) {
  const [width, setWidth] = useState(0);
  const span = STRAIGHTEN_LIMIT * 2;
  const toDeg = (x: number) =>
    width > 0 ? clampStraighten((x / width) * span - STRAIGHTEN_LIMIT) : value;
  const pan = Gesture.Pan()
    .runOnJS(true)
    .minDistance(0)
    .onBegin((e) => onChange(toDeg(e.x)))
    .onUpdate((e) => onChange(toDeg(e.x)));
  const thumbX = width > 0 ? ((value + STRAIGHTEN_LIMIT) / span) * width : 0;
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.label}>{`Straighten ${value > 0 ? '+' : ''}${value}°`}</Text>
      <GestureDetector gesture={pan}>
        <View
          testID="photo-straighten"
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="Straighten"
          accessibilityValue={{ min: -STRAIGHTEN_LIMIT, max: STRAIGHTEN_LIMIT, now: value, text: `${value} degrees` }}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(e) =>
            onChange(clampStraighten(value + (e.nativeEvent.actionName === 'increment' ? 1 : -1)))
          }
          onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
          style={styles.track}
        >
          <View style={styles.trackLine} />
          <View style={[styles.trackCenter, { left: width / 2 - 1 }]} />
          <View style={[styles.thumb, { left: thumbX - 11 }]} />
        </View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 8 },
  title: { color: '#FFFFFF', fontSize: 17, fontWeight: '600' },
  stage: { flex: 1, margin: 16, alignItems: 'center', justifyContent: 'center' },
  hint: { color: '#FFFFFF', fontSize: 15, textAlign: 'center', paddingHorizontal: 24, paddingVertical: 8 },
  tools: { paddingHorizontal: 20, paddingBottom: 8, gap: 8 },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  label: { color: '#FFFFFF', fontSize: 14, textAlign: 'center' },
  shade: { position: 'absolute', backgroundColor: 'rgba(0,0,0,0.55)' },
  frame: { position: 'absolute', borderWidth: 2, borderColor: '#FFFFFF' },
  handle: {
    position: 'absolute',
    width: CORNER,
    height: CORNER,
    alignItems: 'center',
    justifyContent: 'center',
  },
  handleDot: { width: 18, height: 18, borderRadius: 9, backgroundColor: '#FFFFFF' },
  track: { height: 36, justifyContent: 'center' },
  trackLine: { height: 2, backgroundColor: 'rgba(255,255,255,0.5)' },
  trackCenter: { position: 'absolute', width: 2, height: 14, backgroundColor: '#FFFFFF' },
  thumb: { position: 'absolute', width: 22, height: 22, borderRadius: 11, backgroundColor: '#FFFFFF' },
});

