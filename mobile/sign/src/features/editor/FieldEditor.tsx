// Step 3 "Fields" — the full field editor (handoff §4.6; directive §5 "Fields"; §10).
//   Toolbar: signer chips (dot, first name, field count), Undo (30 steps), zoom
//            100 / 150 / 200 %. Wraps at large text sizes.
//   Canvas:  real PDF pages (PdfPageView) scrolling both ways; a picked tool outlines
//            the pages; tap to place (centred on the tap, inside the page).
//   Panel:   no selection -> hint + the 4 tools (C-13) + "Place at center";
//            selection -> "{Type} · {Signer}", Done, Assign, Required/Optional,
//            move and resize controls (accessible placement, handoff §7), Delete.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import { Button } from '../../components/Button';
import { recipientColor, useTheme } from '../../theme';
import { randomId } from '../../util/ids';
import {
  editorReducer,
  fieldAccessibilityLabel,
  fieldCounts,
  initialEditorState,
  type EditorAction,
  type EditorField,
} from './editorReducer';
import { AUTHORING_FIELD_TYPES, FIELD_TYPE_SPECS, type AuthoringFieldType } from './fieldTypes';
import { scaleFor, screenToEditorPoint, type PageSize } from './geometry';
import { FieldBox } from './FieldBox';
import { PdfPageView } from './PdfPageView';

export const ZOOM_LEVELS = [1, 1.5, 2] as const;
/** Points moved / resized per tap of an accessible control. */
export const NUDGE_POINTS = 4;

export interface EditorDocument {
  readonly key: string;
  readonly title: string;
}

export interface EditorRecipient {
  readonly key: string;
  readonly name: string;
}

export interface LoadedAsset {
  readonly base64: string;
  readonly pages: readonly PageSize[];
}

export interface FieldEditorProps {
  readonly documents: readonly EditorDocument[];
  readonly recipients: readonly EditorRecipient[];
  readonly initialFields: readonly EditorField[];
  readonly loadAsset: (docKey: string) => Promise<LoadedAsset>;
  readonly onFieldsChange: (fields: readonly EditorField[]) => void;
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

interface PageRef {
  readonly docKey: string;
  readonly page: number;
  readonly y: number;
}

export function FieldEditor({
  documents,
  recipients,
  initialFields,
  loadAsset,
  onFieldsChange,
}: FieldEditorProps) {
  const t = useTheme();
  const { width: windowWidth } = useWindowDimensions();
  const [state, rawDispatch] = useReducer(editorReducer, undefined, () =>
    initialEditorState(initialFields, recipients[0]?.key ?? null),
  );
  const dispatch = useCallback((a: EditorAction) => rawDispatch(a), []);
  const [zoomIndex, setZoomIndex] = useState(0);
  const [assets, setAssets] = useState<Record<string, LoadedAsset | 'failed'>>({});
  const [gesture, setGesture] = useState(false);
  const pageTops = useRef(new Map<string, PageRef>());
  const scrollY = useRef(0);
  const [visible, setVisible] = useState<{ docKey: string; page: number } | null>(null);

  // Load every document's bytes + page sizes (once per document).
  const requested = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    for (const d of documents) {
      if (requested.current.has(d.key)) continue;
      requested.current.add(d.key);
      loadAsset(d.key)
        .then((a) => mounted.current && setAssets((s) => ({ ...s, [d.key]: a })))
        .catch(() => mounted.current && setAssets((s) => ({ ...s, [d.key]: 'failed' })));
    }
  }, [documents, loadAsset]);

  // Report committed changes (not the initial load) to the draft.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!gesture) onFieldsChange(state.fields);
  }, [state.fields, gesture, onFieldsChange]);

  // Recipients edited on step 2 while the editor was open.
  const recipientKeys = recipients.map((r) => r.key).join('|');
  useEffect(() => {
    dispatch({
      type: 'recipientsChanged',
      recipientKeys: recipientKeys ? recipientKeys.split('|') : [],
    });
  }, [recipientKeys, dispatch]);

  const zoom = ZOOM_LEVELS[zoomIndex] ?? 1;
  const baseWidth = Math.max(240, windowWidth - 32);
  const pageWidth = baseWidth * zoom;
  const colorOf = (key: string) =>
    recipientColor(
      Math.max(
        0,
        recipients.findIndex((r) => r.key === key),
      ),
    );
  const nameOf = (key: string) => recipients.find((r) => r.key === key)?.name ?? 'Unassigned';
  const counts = fieldCounts(state.fields);
  const selected = state.fields.find((f) => f.key === state.selected) ?? null;
  const active = recipients.find((r) => r.key === state.activeRecipient) ?? recipients[0] ?? null;

  const pageSizeOf = (docKey: string, page: number): PageSize | undefined => {
    const a = assets[docKey];
    return a && a !== 'failed' ? a.pages[page] : undefined;
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollY.current = e.nativeEvent.contentOffset.y;
    const probe = scrollY.current + e.nativeEvent.layoutMeasurement.height / 3;
    let best: PageRef | null = null;
    for (const p of pageTops.current.values())
      if (p.y <= probe && (!best || p.y > best.y)) best = p;
    if (best && (best.docKey !== visible?.docKey || best.page !== visible?.page)) {
      setVisible({ docKey: best.docKey, page: best.page });
    }
  };

  const placeAtCenter = () => {
    const target = visible ?? (documents[0] ? { docKey: documents[0].key, page: 0 } : null);
    if (!target) return;
    const size = pageSizeOf(target.docKey, target.page);
    if (!size) return;
    dispatch({
      type: 'placeAtCenter',
      key: randomId(),
      docKey: target.docKey,
      page: target.page,
      pageSize: size,
    });
  };

  const hint = state.tool
    ? `Tap the page to place ${FIELD_TYPE_SPECS[state.tool].noun} for ${firstName(active?.name ?? '')}`
    : 'Pick a field, then tap the page. Drag to move, use the corner to resize.';

  const text = { color: t.color.text, fontFamily: t.font.family };
  const secondary = { color: t.color.textSecondary, fontFamily: t.font.family };

  return (
    <View style={styles.fill}>
      {/* Toolbar */}
      <View
        style={[
          styles.toolbar,
          { borderBottomColor: t.color.separator, backgroundColor: t.color.surface },
        ]}
      >
        <View style={styles.chips} accessibilityRole="tablist">
          {recipients.map((r, i) => {
            const on = r.key === state.activeRecipient;
            const c = recipientColor(i);
            return (
              <Pressable
                key={r.key}
                onPress={() => dispatch({ type: 'setRecipient', recipientKey: r.key })}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`${r.name}, ${counts.get(r.key) ?? 0} fields`}
                style={[
                  styles.chip,
                  { minHeight: t.size.minTouch, borderColor: on ? c : t.color.separator },
                  on ? { backgroundColor: `${c}1A` } : null,
                ]}
              >
                <View style={[styles.dot, { backgroundColor: c }]} />
                <Text style={[text, styles.chipText]}>{firstName(r.name)}</Text>
                <Text style={[secondary, styles.chipText]}>{counts.get(r.key) ?? 0}</Text>
              </Pressable>
            );
          })}
        </View>
        <View style={styles.toolbarRow}>
          <Button
            title="Undo"
            variant="text"
            onPress={() => dispatch({ type: 'undo' })}
            disabled={state.undo.length === 0}
            accessibilityHint="Undoes the last change to the fields"
          />
          <View style={styles.zoom}>
            <Button
              title="−"
              variant="text"
              accessibilityLabel="Zoom out"
              disabled={zoomIndex === 0}
              onPress={() => setZoomIndex((z) => Math.max(0, z - 1))}
            />
            <Text
              style={[text, styles.zoomText]}
              accessibilityLabel={`Zoom ${Math.round(zoom * 100)} percent`}
            >
              {`${Math.round(zoom * 100)}%`}
            </Text>
            <Button
              title="+"
              variant="text"
              accessibilityLabel="Zoom in"
              disabled={zoomIndex === ZOOM_LEVELS.length - 1}
              onPress={() => setZoomIndex((z) => Math.min(ZOOM_LEVELS.length - 1, z + 1))}
            />
          </View>
        </View>
      </View>

      {/* Canvas */}
      <ScrollView
        style={[styles.fill, { backgroundColor: t.color.documentBackdrop }]}
        contentContainerStyle={styles.canvas}
        scrollEnabled={!gesture}
        onScroll={onScroll}
        scrollEventThrottle={64}
      >
        <ScrollView
          horizontal
          scrollEnabled={!gesture && zoom > 1}
          contentContainerStyle={styles.hscroll}
        >
          <View style={styles.pages}>
            {documents.map((d) => {
              const a = assets[d.key];
              if (!a) {
                return (
                  <View key={d.key} style={[styles.loading, { width: pageWidth }]}>
                    <ActivityIndicator
                      color={t.color.accent}
                      accessibilityLabel={`Loading ${d.title}`}
                    />
                  </View>
                );
              }
              if (a === 'failed') {
                return (
                  <View key={d.key} style={[styles.loading, { width: pageWidth }]}>
                    <Text
                      style={secondary}
                    >{`${d.title} couldn’t be shown. Check your connection and try again.`}</Text>
                  </View>
                );
              }
              return a.pages.map((size, pi) => {
                const scale = scaleFor(size, pageWidth);
                const fields = state.fields.filter((f) => f.docKey === d.key && f.page === pi);
                const id = `${d.key}:${pi}`;
                return (
                  <View
                    key={id}
                    onLayout={(e: LayoutChangeEvent) =>
                      pageTops.current.set(id, {
                        docKey: d.key,
                        page: pi,
                        y: e.nativeEvent.layout.y,
                      })
                    }
                  >
                    <PdfPageView
                      base64={a.base64}
                      pageIndex={pi}
                      page={size}
                      width={pageWidth}
                      highlighted={state.tool !== null}
                      label={`${d.title}, page ${pi + 1} of ${a.pages.length}`}
                    >
                      <Pressable
                        style={StyleSheet.absoluteFill}
                        accessible={false}
                        importantForAccessibility="no"
                        onPress={(e) => {
                          if (state.tool) {
                            dispatch({
                              type: 'placeAt',
                              key: randomId(),
                              docKey: d.key,
                              page: pi,
                              pageSize: size,
                              center: screenToEditorPoint(
                                { x: e.nativeEvent.locationX, y: e.nativeEvent.locationY },
                                scale,
                              ),
                            });
                          } else dispatch({ type: 'select', key: null });
                        }}
                      />
                      {fields.map((f) => (
                        <FieldBox
                          key={f.key}
                          field={f}
                          page={size}
                          scale={scale}
                          color={colorOf(f.recipientKey)}
                          selected={f.key === state.selected}
                          accessibilityLabel={fieldAccessibilityLabel(f, nameOf(f.recipientKey))}
                          dispatch={dispatch}
                          onGesture={setGesture}
                        />
                      ))}
                    </PdfPageView>
                  </View>
                );
              });
            })}
          </View>
        </ScrollView>
      </ScrollView>

      {/* Bottom panel */}
      <View
        style={[
          styles.panel,
          { backgroundColor: t.color.surface, borderTopColor: t.color.separator },
        ]}
      >
        {selected ? (
          <SelectionPanel
            field={selected}
            recipients={recipients}
            color={colorOf(selected.recipientKey)}
            signerName={nameOf(selected.recipientKey)}
            pageSize={pageSizeOf(selected.docKey, selected.page)}
            dispatch={dispatch}
          />
        ) : (
          <View style={styles.panelBody}>
            <Text style={[secondary, styles.hint]} accessibilityLiveRegion="polite">
              {hint}
            </Text>
            <View style={styles.tools}>
              {AUTHORING_FIELD_TYPES.map((type) => (
                <ToolButton
                  key={type}
                  type={type}
                  active={state.tool === type}
                  disabled={recipients.length === 0}
                  onPress={() =>
                    dispatch({ type: 'pickTool', tool: state.tool === type ? null : type })
                  }
                />
              ))}
            </View>
            <Button
              title="Place at center"
              variant="secondary"
              disabled={state.tool === null}
              accessibilityHint="Places the picked field in the middle of the page in view"
              onPress={placeAtCenter}
            />
          </View>
        )}
      </View>
    </View>
  );
}

function ToolButton({
  type,
  active,
  disabled,
  onPress,
}: {
  readonly type: AuthoringFieldType;
  readonly active: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`${FIELD_TYPE_SPECS[type].label} field`}
      accessibilityState={{ selected: active, disabled }}
      style={[
        styles.tool,
        {
          minHeight: t.size.minTouch,
          borderColor: active ? t.color.accent : t.color.separator,
          borderWidth: active ? 1.5 : 1,
          backgroundColor: active ? t.color.tint : t.color.surface,
          opacity: disabled ? 0.42 : 1,
        },
      ]}
    >
      <Text
        style={{
          color: active ? t.color.onTint : t.color.text,
          fontFamily: t.font.family,
          fontSize: 15,
        }}
      >
        {FIELD_TYPE_SPECS[type].label}
      </Text>
    </Pressable>
  );
}

function SelectionPanel({
  field,
  recipients,
  color,
  signerName,
  pageSize,
  dispatch,
}: {
  readonly field: EditorField;
  readonly recipients: readonly EditorRecipient[];
  readonly color: string;
  readonly signerName: string;
  readonly pageSize: PageSize | undefined;
  readonly dispatch: (a: EditorAction) => void;
}) {
  const t = useTheme();
  const keys = recipients.map((r) => r.key);
  const i = keys.indexOf(field.recipientKey);
  const next = recipients[(i + 1) % Math.max(1, recipients.length)];
  const nudge = (dx: number, dy: number) =>
    pageSize && dispatch({ type: 'nudge', key: field.key, dx, dy, pageSize });
  const grow = (dw: number, dh: number) =>
    pageSize && dispatch({ type: 'grow', key: field.key, dw, dh, pageSize });
  const n = NUDGE_POINTS;
  return (
    <View style={styles.panelBody}>
      <View style={styles.selHeader}>
        <View style={[styles.selDot, { backgroundColor: color }]} />
        <Text
          accessibilityRole="header"
          style={[styles.selTitle, { color: t.color.text, fontFamily: t.font.family }]}
          numberOfLines={2}
        >
          {`${FIELD_TYPE_SPECS[field.type].label} · ${signerName}`}
        </Text>
        <Button
          title="Done"
          variant="text"
          onPress={() => dispatch({ type: 'select', key: null })}
        />
      </View>
      <View style={styles.row}>
        <Button
          style={styles.grow}
          variant="secondary"
          title={recipients.length > 1 ? `Assign to ${firstName(next?.name ?? '')}` : 'One signer'}
          disabled={recipients.length < 2}
          onPress={() => dispatch({ type: 'reassign', key: field.key, recipientKeys: keys })}
        />
        <Button
          style={styles.grow}
          variant="secondary"
          title={field.required ? 'Required ✓' : 'Optional'}
          accessibilityLabel={field.required ? 'Required' : 'Optional'}
          accessibilityHint="Switches between required and optional"
          onPress={() => dispatch({ type: 'toggleRequired', key: field.key })}
        />
      </View>
      <View style={styles.row} accessibilityLabel="Move">
        <Button
          style={styles.grow}
          variant="text"
          title="←"
          accessibilityLabel="Move left"
          onPress={() => nudge(-n, 0)}
        />
        <Button
          style={styles.grow}
          variant="text"
          title="↑"
          accessibilityLabel="Move up"
          onPress={() => nudge(0, -n)}
        />
        <Button
          style={styles.grow}
          variant="text"
          title="↓"
          accessibilityLabel="Move down"
          onPress={() => nudge(0, n)}
        />
        <Button
          style={styles.grow}
          variant="text"
          title="→"
          accessibilityLabel="Move right"
          onPress={() => nudge(n, 0)}
        />
      </View>
      <View style={styles.row} accessibilityLabel="Resize">
        <Button style={styles.grow} variant="text" title="Narrower" onPress={() => grow(-n, 0)} />
        <Button style={styles.grow} variant="text" title="Wider" onPress={() => grow(n, 0)} />
        <Button style={styles.grow} variant="text" title="Shorter" onPress={() => grow(0, -n)} />
        <Button style={styles.grow} variant="text" title="Taller" onPress={() => grow(0, n)} />
      </View>
      <Button
        title="Delete"
        variant="destructive"
        onPress={() => dispatch({ type: 'delete', key: field.key })}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  toolbar: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    borderRadius: 18,
    borderWidth: 1.5,
  },
  chipText: { fontSize: 14 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  toolbarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
  },
  zoom: { flexDirection: 'row', alignItems: 'center' },
  zoomText: { minWidth: 48, textAlign: 'center', fontSize: 15 },
  canvas: { paddingVertical: 16 },
  hscroll: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 16 },
  pages: { gap: 12 },
  loading: { height: 240, alignItems: 'center', justifyContent: 'center', padding: 24 },
  panel: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
  },
  panelBody: { gap: 10 },
  hint: { fontSize: 14, lineHeight: 19 },
  tools: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tool: {
    flexBasis: '47%',
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
  },
  selHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  selDot: { width: 12, height: 12, borderRadius: 6 },
  selTitle: { flex: 1, fontSize: 15, fontWeight: '600' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  grow: { flexGrow: 1 },
});
