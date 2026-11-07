// Step 3 "Fields" — the full field editor (handoff §4.6; directive §5 "Fields"; §10).
//   Toolbar: signer chips (dot, first name, field count), Undo (30 steps), zoom
//            Fit / 150 / 200 % (M-A13 #11, R-5). Wraps at large text sizes.
//   Canvas:  real PDF pages (PdfPageView) scrolling both ways; a picked tool outlines
//            the pages; tap to place (centred on the tap, inside the page).
//   Panel:   no selection -> hint + the tools (C-13's four, plus Name and Checkbox
//            when FEATURES.extraFieldTypes, M-A6 §2) + "Place at center";
//            selection -> "{Type} · {Signer}", Done, Assign, Required/Optional,
//            Settings (Name and Checkbox), move and resize controls (accessible
//            placement, handoff §7), Delete.
//   M-A12 W1-C: "Page n of N" with up / down arrows, Find in document (the server's
//            text layer, searched and highlighted on the device), the profile field
//            types, and the user's default field size. W1-A: self-sign shows each
//            placed field's value (fillFor) and its value editor (renderSelectionExtra).
//   M-A13 #2: the panel is capped at 40% of the editor and scrolls; the canvas keeps at
//            least 50%; more than 8 tools collapse behind "More fields"; "Place at
//            center" stays pinned above the bottom inset. #3: placeRequest places and
//            selects a field at the centre of the page in view.
//   M-A14:   `selfSign` switches to the Sign Document look (a08–a10, b01, b02) — the
//            suggestion banner or a Find-only toolbar, full-width pages, the Find in
//            Document sheet, and a bottom sheet with the R-6 tool row, the armed-tool
//            hint, ▲▼ page buttons and Finish. The Send flow never sets it and is
//            unchanged.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import { Button } from '../../components/Button';
import { Sheet } from '../../components/Sheet';
import { recipientColor, useTheme } from '../../theme';
import { randomId } from '../../util/ids';
import {
  editorReducer,
  fieldAccessibilityLabel,
  fieldCounts,
  groupMembers,
  initialEditorState,
  nextGroupKey,
  type EditorAction,
  type EditorField,
} from './editorReducer';
import {
  FIELD_TYPE_SPECS,
  MAX_LABEL,
  selfSignTools,
  toolFieldTypes,
  visibleTools,
  zoomLabel,
  type AuthoringFieldType,
} from './fieldTypes';
import { scaleFor, screenToEditorPoint, type PageSize } from './geometry';
import { FindBar, HighlightOverlay, ICON_DOWN, ICON_UP, PageNavigator } from '../find/FindBar';
import { FindSheet } from '../find/FindSheet';
import { pageLabel } from '../find/findModel';
import { useKeyboardHeight } from '../../components/sheetKeyboard';
import Svg, { Path } from 'react-native-svg';
import { useFind, type FindDoc } from '../find/useFind';
import { FieldBox, type FieldFill } from './FieldBox';
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
  /** M-A12 W1-A — the value each placed field shows (self-sign fills fields at once). */
  readonly fillFor?: (field: EditorField) => FieldFill | null;
  /** Called before a tool is picked; false stops it (e.g. adopt a signature first). */
  readonly onPickTool?: (type: AuthoringFieldType) => boolean;
  /** Extra controls in the selection panel (self-sign: the field's value). */
  readonly renderSelectionExtra?: (field: EditorField) => ReactNode;
  /** M-A12 W1-E.2 — the starting size of a placed field (1 = the type's default). */
  readonly fieldScale?: number;
  /** M-A12 W1-C.2 — how Find reads each document's text (keyed like `documents`). */
  readonly findDocs?: readonly FindDoc[];
  /** One signer (self-sign): the recipient chips are hidden. */
  readonly hideRecipients?: boolean;
  /** Extra toolbar controls (self-sign: the "…" menu). */
  readonly toolbarExtra?: ReactNode;
  /** M-A13 #3 — place this type at the centre of the page in view and select it (once per id). */
  readonly placeRequest?: { readonly type: AuthoringFieldType; readonly id: number } | null;
  /** M-A13 #2 — the system bottom inset when nothing below the editor already clears it. */
  readonly bottomInset?: number;
  /** M-A14 — the Sign Document look; never set by the Send flow. */
  readonly selfSign?: SelfSignChrome;
}

export interface SelfSignChrome {
  /** The suggestion banner; null shows the Find toolbar instead (§1 item 4). */
  readonly banner: ReactNode | null;
  readonly onFinish: () => void;
  readonly finishDisabled?: boolean;
  /** Arm this tool (once per id): Finish without a signature arms Signature. */
  readonly armRequest?: { readonly type: AuthoringFieldType; readonly id: number } | null;
  /** A placed field was tapped (e.g. an unadopted signature opens the adopt sheet). */
  readonly onFieldTap?: (field: EditorField) => void;
}

const SELF_INK = '#0D1B4C';
const SELF_SECONDARY = '#4A5578';
const SELF_BACKDROP = '#F4F4F6';
const SELF_TOOL_CIRCLE = '#DCE4FF';
/** The tool sheet's rounded top overlaps the canvas by this much. */
const SELF_SHEET_OVERLAP = 26;

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
  fillFor,
  onPickTool,
  renderSelectionExtra,
  fieldScale = 1,
  findDocs,
  hideRecipients = false,
  toolbarExtra,
  placeRequest = null,
  bottomInset = 0,
  selfSign,
}: FieldEditorProps) {
  const t = useTheme();
  const { width: windowWidth } = useWindowDimensions();
  const [state, rawDispatch] = useReducer(editorReducer, undefined, () =>
    initialEditorState(initialFields, recipients[0]?.key ?? null),
  );
  const dispatch = useCallback((a: EditorAction) => rawDispatch(a), []);
  const [zoomIndex, setZoomIndex] = useState(0);
  const [moreTools, setMoreTools] = useState(false);
  const [assets, setAssets] = useState<Record<string, LoadedAsset | 'failed'>>({});
  const [gesture, setGesture] = useState(false);
  const pageTops = useRef(new Map<string, PageRef>());
  const scrollY = useRef(0);
  const viewport = useRef(0);
  const scrollRef = useRef<ScrollView>(null);
  const [visible, setVisible] = useState<{ docKey: string; page: number } | null>(null);
  const noFind = useMemo<readonly FindDoc[]>(() => [], []);
  const find = useFind(findDocs ?? noFind);

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

  // M-A14 — a tapped field is reported (stable dispatch for the field gestures).
  const fieldsRef = useRef(state.fields);
  const onFieldTapRef = useRef(selfSign?.onFieldTap);
  const onFieldTap = selfSign?.onFieldTap;
  useEffect(() => {
    fieldsRef.current = state.fields;
    onFieldTapRef.current = onFieldTap;
  }, [state.fields, onFieldTap]);
  const boxDispatch = useCallback(
    (a: EditorAction) => {
      dispatch(a);
      if (a.type === 'select' && a.key) {
        const f = fieldsRef.current.find((x) => x.key === a.key);
        if (f) onFieldTapRef.current?.(f);
      }
    },
    [dispatch],
  );

  const zoom = selfSign ? 1 : (ZOOM_LEVELS[zoomIndex] ?? 1);
  const baseWidth = selfSign ? Math.max(240, windowWidth) : Math.max(240, windowWidth - 32);
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

  // W1-C.1 — every loaded page in order, for "Page n of N" and the arrows.
  const allPages: { docKey: string; page: number; size: PageSize }[] = [];
  for (const d of documents) {
    const a = assets[d.key];
    if (a && a !== 'failed') a.pages.forEach((size, page) => allPages.push({ docKey: d.key, page, size }));
  }
  const currentIndex = Math.max(
    0,
    allPages.findIndex((p) => p.docKey === (visible?.docKey ?? documents[0]?.key) && p.page === (visible?.page ?? 0)),
  );
  const CANVAS_TOP = selfSign ? 0 : 16;
  const scrollToPage = (docKey: string, page: number, dy = 0) => {
    const top = pageTops.current.get(`${docKey}:${page}`);
    if (!top) return;
    setVisible({ docKey, page });
    scrollRef.current?.scrollTo({ y: Math.max(0, top.y + CANVAS_TOP + dy), animated: true });
  };
  const stepPage = (dir: 1 | -1) => {
    const target = allPages[currentIndex + dir];
    if (target) scrollToPage(target.docKey, target.page);
  };
  const showMatch = (m: ReturnType<typeof find.next>) => {
    if (!m) return;
    const size = pageSizeOf(m.docKey, m.page);
    const h = size ? scaleFor(size, pageWidth) * size.height : 0;
    scrollToPage(m.docKey, m.page, Math.max(0, (m.rects[0]?.y ?? 0) * h - 80));
  };
  const firstMatch = find.matches[0];
  const firstKey = firstMatch ? `${firstMatch.docKey}:${firstMatch.page}:${find.query}` : null;
  useEffect(() => {
    if (firstKey && firstMatch) showMatch(firstMatch);
    // Scroll once when the first match of a new query appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstKey]);

  const placeAtCenter = (tool?: AuthoringFieldType) => {
    const target = visible ?? (documents[0] ? { docKey: documents[0].key, page: 0 } : null);
    if (!target) return;
    const size = pageSizeOf(target.docKey, target.page);
    if (!size) return;
    if (tool) dispatch({ type: 'pickTool', tool });
    dispatch({
      type: 'placeAtCenter',
      key: randomId(),
      docKey: target.docKey,
      page: target.page,
      pageSize: size,
      scale: fieldScale,
    });
  };

  // M-A13 #3 — e.g. after adopting a signature that was picked as a tool.
  const placeId = placeRequest?.id ?? null;
  useEffect(() => {
    if (placeRequest) placeAtCenter(placeRequest.type);
    // Once per request id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placeId]);

  // M-A14 — Finish without a signature arms Signature (once per request id).
  const armId = selfSign?.armRequest?.id ?? null;
  useEffect(() => {
    const req = selfSign?.armRequest;
    if (req) dispatch({ type: 'pickTool', tool: req.type });
    // Once per request id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armId]);

  const allTools = toolFieldTypes();
  const tools = visibleTools(allTools, moreTools, state.tool);
  const collapsible = tools.length < allTools.length || moreTools;

  const hint = state.tool
    ? `Tap the page to place ${FIELD_TYPE_SPECS[state.tool].noun} for ${firstName(active?.name ?? '')}`
    : 'Pick a field, then tap the page. Drag to move, use the corner to resize.';

  const text = { color: t.color.text, fontFamily: t.font.family };
  const secondary = { color: t.color.textSecondary, fontFamily: t.font.family };

  const canvas = (
    <ScrollView
      ref={scrollRef}
      onLayout={(e: LayoutChangeEvent) => (viewport.current = e.nativeEvent.layout.height)}
      style={[styles.fill, styles.canvasMin, { backgroundColor: selfSign ? SELF_BACKDROP : t.color.documentBackdrop }]}
      contentContainerStyle={selfSign ? styles.selfCanvas : styles.canvas}
      scrollEnabled={!gesture}
      onScroll={onScroll}
      scrollEventThrottle={64}
    >
      <ScrollView
        horizontal
        scrollEnabled={!gesture && zoom > 1}
        contentContainerStyle={selfSign ? styles.selfHscroll : styles.hscroll}
      >
        <View style={selfSign ? styles.selfPages : styles.pages}>
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
                            scale: fieldScale,
                          });
                        } else dispatch({ type: 'select', key: null });
                      }}
                    />
                    <HighlightOverlay
                      rects={find.highlights(d.key, pi)}
                      width={pageWidth}
                      height={scale * size.height}
                    />
                    {fields.map((f) => (
                      <FieldBox
                        fill={fillFor ? fillFor(f) : null}
                        key={f.key}
                        field={f}
                        page={size}
                        scale={scale}
                        color={colorOf(f.recipientKey)}
                        selected={f.key === state.selected}
                        accessibilityLabel={fieldAccessibilityLabel(f, nameOf(f.recipientKey))}
                        dispatch={selfSign ? boxDispatch : dispatch}
                        onGesture={setGesture}
                        look={selfSign ? 'self' : 'send'}
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
  );

  if (selfSign) {
    return (
      <SelfSignLayout
        chrome={selfSign}
        canvas={canvas}
        find={find}
        findEnabled={!!findDocs}
        tool={state.tool}
        extra={selected && renderSelectionExtra ? renderSelectionExtra(selected) : null}
        page={allPages.length > 0 ? pageLabel(currentIndex + 1, allPages.length) : null}
        canPrev={currentIndex > 0}
        canNext={currentIndex < allPages.length - 1}
        onPrev={() => stepPage(-1)}
        onNext={() => stepPage(1)}
        onShowMatch={(m) => {
          find.hide();
          showMatch(m);
        }}
        onPickTool={(type) => {
          if (state.tool !== type && onPickTool && !onPickTool(type)) return;
          dispatch({ type: 'pickTool', tool: state.tool === type ? null : type });
        }}
        onPlaceAtCenter={() => placeAtCenter()}
        bottomInset={bottomInset}
      />
    );
  }

  return (
    <View style={styles.fill}>
      {/* Toolbar */}
      <View
        style={[
          styles.toolbar,
          { borderBottomColor: t.color.separator, backgroundColor: t.color.surface },
        ]}
      >
        {hideRecipients ? null : (
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
        )}
        <View style={styles.toolbarRow}>
          {allPages.length > 0 ? (
            <PageNavigator
              current={currentIndex + 1}
              total={allPages.length}
              onPrev={() => stepPage(-1)}
              onNext={() => stepPage(1)}
            />
          ) : null}
          {findDocs ? (
            <Button
              testID="editor-find"
              title="Find"
              variant="text"
              accessibilityHint="Searches the text of the documents"
              onPress={() => (find.open ? find.close() : find.show())}
            />
          ) : null}
          {toolbarExtra}
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
              accessibilityLabel={zoomLabel(zoom).accessibility}
            >
              {zoomLabel(zoom).text}
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

      {find.open ? (
        <FindBar
          query={find.query}
          onQuery={find.setQuery}
          status={find.status}
          canStep={find.matches.length > 1}
          onPrev={() => showMatch(find.prev())}
          onNext={() => showMatch(find.next())}
          onClose={find.close}
        />
      ) : null}

      {canvas}

      {/* Bottom panel: at most 40% of the editor, scrolling (M-A13 #2). */}
      <View
        testID="editor-panel"
        style={[
          styles.panel,
          {
            backgroundColor: t.color.surface,
            borderTopColor: t.color.separator,
            paddingBottom: 12 + bottomInset,
          },
        ]}
      >
        <ScrollView
          style={styles.panelScroll}
          contentContainerStyle={styles.panelBody}
          keyboardShouldPersistTaps="handled"
        >
          {selected ? (
            <SelectionPanel
              key={selected.key}
              field={selected}
              fields={state.fields}
              recipients={recipients}
              color={colorOf(selected.recipientKey)}
              signerName={nameOf(selected.recipientKey)}
              pageSize={pageSizeOf(selected.docKey, selected.page)}
              dispatch={dispatch}
              extra={renderSelectionExtra ? renderSelectionExtra(selected) : null}
            />
          ) : (
            <>
              <Text style={[secondary, styles.hint]} accessibilityLiveRegion="polite">
                {hint}
              </Text>
              <View style={styles.tools}>
                {tools.map((type) => (
                  <ToolButton
                    key={type}
                    type={type}
                    active={state.tool === type}
                    disabled={recipients.length === 0}
                    onPress={() => {
                      if (state.tool !== type && onPickTool && !onPickTool(type)) return;
                      dispatch({ type: 'pickTool', tool: state.tool === type ? null : type });
                    }}
                  />
                ))}
              </View>
              {collapsible ? (
                <Button
                  testID="editor-more-fields"
                  title={moreTools ? 'Fewer fields' : 'More fields'}
                  variant="text"
                  accessibilityHint={moreTools ? 'Shows only the common fields' : 'Shows every field type'}
                  onPress={() => setMoreTools((m) => !m)}
                />
              ) : null}
            </>
          )}
        </ScrollView>
        {/* Pinned below the scrolling tools, so it is never scrolled or inset away. */}
        {selected ? null : (
          <Button
            title="Place at center"
            variant="secondary"
            disabled={state.tool === null}
            accessibilityHint="Places the picked field in the middle of the page in view"
            onPress={() => placeAtCenter()}
          />
        )}
      </View>
    </View>
  );
}

function SelfGlyph({ d, color, size = 22, width = 1.8 }: { d: string; color: string; size?: number; width?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round">
      <Path d={d} />
    </Svg>
  );
}

const ICON_SEARCH = 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-3.5-3.5';

/** M-A14 §1 item 4 — the Sign Document chrome around the shared canvas. */
function SelfSignLayout({
  chrome,
  canvas,
  find,
  findEnabled,
  tool,
  extra,
  page,
  canPrev,
  canNext,
  onPrev,
  onNext,
  onShowMatch,
  onPickTool,
  onPlaceAtCenter,
  bottomInset,
}: {
  readonly chrome: SelfSignChrome;
  readonly canvas: ReactNode;
  readonly find: ReturnType<typeof useFind>;
  readonly findEnabled: boolean;
  readonly tool: AuthoringFieldType | null;
  readonly extra: ReactNode;
  readonly page: string | null;
  readonly canPrev: boolean;
  readonly canNext: boolean;
  readonly onPrev: () => void;
  readonly onNext: () => void;
  readonly onShowMatch: (m: ReturnType<typeof useFind>['matches'][number]) => void;
  readonly onPickTool: (type: AuthoringFieldType) => void;
  readonly onPlaceAtCenter: () => void;
  readonly bottomInset: number;
}) {
  const t = useTheme();
  const font = { fontFamily: t.font.family };
  const tools = selfSignTools();
  const armed = tools.find((x) => x.type === tool) ?? null;
  // Keyboard-aware Find sheet (M-A13 #5): lifted by whatever of the keyboard is not
  // already absorbed by a resized window or covered by the tool sheet.
  // The field-value input in the tool sheet is lifted the same way.
  const keyboard = useKeyboardHeight(true);
  const [sheetHeight, setSheetHeight] = useState(0);
  const [heights, setHeights] = useState({ full: 0, current: 0 });
  const resizedBy = Math.max(0, heights.full - heights.current);
  const findBottom = Math.max(0, keyboard - resizedBy - sheetHeight);
  const sheetLift = find.open ? 0 : Math.max(0, keyboard - resizedBy - bottomInset);
  return (
    <View
      style={styles.fill}
      testID="self-editor"
      onLayout={(e) => {
        const h = e.nativeEvent.layout.height;
        setHeights((x) => ({ full: Math.max(x.full, h), current: h }));
      }}
    >
      {chrome.banner ?? (
        <View style={styles.selfToolbar}>
          {findEnabled ? (
            <Pressable
              testID="editor-find"
              onPress={() => (find.open ? find.close() : find.show())}
              accessibilityRole="button"
              accessibilityLabel="Find in document"
              accessibilityState={{ expanded: find.open }}
              style={[styles.selfFindBtn, { backgroundColor: find.open ? '#1B1037' : 'transparent' }]}
            >
              <SelfGlyph d={ICON_SEARCH} color={find.open ? '#FFFFFF' : SELF_INK} size={22} width={2.2} />
            </Pressable>
          ) : null}
        </View>
      )}
      <View style={[styles.fill, styles.canvasMin]}>
        {canvas}
        {page && !find.open ? (
          <Text
            testID="self-page-label"
            pointerEvents="none"
            accessibilityLiveRegion="polite"
            style={[styles.selfPageLabel, font, { bottom: SELF_SHEET_OVERLAP + 4 }]}
          >
            {page}
          </Text>
        ) : null}
        {find.open ? <FindSheet find={find} bottom={SELF_SHEET_OVERLAP + findBottom} onGo={onShowMatch} /> : null}
      </View>
      <View
        testID="editor-panel"
        onLayout={(e) => setSheetHeight(e.nativeEvent.layout.height - SELF_SHEET_OVERLAP - sheetLift)}
        style={[styles.selfSheet, { paddingBottom: 12 + bottomInset + sheetLift }]}
      >
        <View style={styles.selfHandle} />
        {extra ? (
          <View testID="self-selection" style={styles.selfExtra}>
            {extra}
          </View>
        ) : null}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.selfTools}
          testID="self-tools"
        >
          {tools.map((x) => {
            const on = tool === x.type;
            return (
              <Pressable
                key={x.type}
                testID={`self-tool-${x.type}`}
                onPress={() => onPickTool(x.type)}
                accessibilityRole="button"
                accessibilityLabel={`${x.label} field`}
                accessibilityState={{ selected: on }}
                style={styles.selfTool}
              >
                <View
                  style={[
                    styles.selfToolCircle,
                    { backgroundColor: on ? SELF_INK : SELF_TOOL_CIRCLE },
                    on ? styles.selfToolRing : null,
                  ]}
                >
                  <SelfGlyph d={x.icon} color={on ? '#FFFFFF' : SELF_INK} />
                </View>
                <Text numberOfLines={1} style={[styles.selfToolLabel, font]}>
                  {x.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
        {armed ? (
          <View style={styles.selfHintRow}>
            <Text testID="self-hint" accessibilityLiveRegion="polite" style={[styles.selfHint, font]}>
              {`Tap the document where the ${armed.label.toLowerCase()} goes`}
            </Text>
            <Pressable
              testID="self-place-center"
              onPress={onPlaceAtCenter}
              accessibilityRole="button"
              accessibilityHint="Places the picked field in the middle of the page in view"
              hitSlop={8}
            >
              <Text style={[styles.selfCenter, font, { color: t.color.accent }]}>Place at center</Text>
            </Pressable>
          </View>
        ) : null}
        <View style={styles.selfActions}>
          <Pressable
            testID="self-page-prev"
            onPress={onPrev}
            disabled={!canPrev}
            accessibilityRole="button"
            accessibilityLabel="Previous page"
            accessibilityState={{ disabled: !canPrev }}
            style={styles.selfPageBtn}
          >
            <SelfGlyph d={ICON_UP} color={SELF_INK} size={22} width={2.4} />
          </Pressable>
          <Pressable
            testID="self-page-next"
            onPress={onNext}
            disabled={!canNext}
            accessibilityRole="button"
            accessibilityLabel="Next page"
            accessibilityState={{ disabled: !canNext }}
            style={styles.selfPageBtn}
          >
            <SelfGlyph d={ICON_DOWN} color={SELF_INK} size={22} width={2.4} />
          </Pressable>
          <View style={styles.fill} />
          <Pressable
            testID="self-finish"
            onPress={chrome.onFinish}
            disabled={chrome.finishDisabled}
            accessibilityRole="button"
            accessibilityLabel="Finish"
            accessibilityState={{ disabled: !!chrome.finishDisabled }}
            style={[styles.selfFinish, { opacity: chrome.finishDisabled ? 0.4 : 1 }]}
          >
            <Text style={[styles.selfFinishText, font]}>Finish</Text>
          </Pressable>
        </View>
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
  fields,
  recipients,
  color,
  signerName,
  pageSize,
  dispatch,
  extra,
}: {
  readonly field: EditorField;
  readonly fields: readonly EditorField[];
  readonly recipients: readonly EditorRecipient[];
  readonly color: string;
  readonly signerName: string;
  readonly pageSize: PageSize | undefined;
  readonly dispatch: (a: EditorAction) => void;
  readonly extra?: ReactNode;
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const configurable = field.type === 'SIGNER_NAME' || field.type === 'CHECKBOX';
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
      {extra}
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
      {configurable ? (
        <Button
          variant="secondary"
          title={field.type === 'SIGNER_NAME' ? 'Name settings' : 'Checkbox settings'}
          onPress={() => setSettingsOpen(true)}
        />
      ) : null}
      {configurable ? (
        <Sheet
          visible={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          title={field.type === 'SIGNER_NAME' ? 'Name' : 'Checkbox'}
        >
          {field.type === 'SIGNER_NAME' ? (
            <NameSettings field={field} dispatch={dispatch} />
          ) : (
            <CheckboxSettings field={field} fields={fields} dispatch={dispatch} />
          )}
          <Button title="Done" onPress={() => setSettingsOpen(false)} />
        </Sheet>
      ) : null}
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

function Choice({
  title,
  selected,
  onPress,
  testID,
}: {
  readonly title: string;
  readonly selected: boolean;
  readonly onPress: () => void;
  readonly testID?: string;
}) {
  const t = useTheme();
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      style={[
        styles.tool,
        {
          minHeight: t.size.minTouch,
          borderColor: selected ? t.color.accent : t.color.separator,
          borderWidth: selected ? 1.5 : 1,
          backgroundColor: selected ? t.color.tint : t.color.surface,
        },
      ]}
    >
      <Text
        style={{
          color: selected ? t.color.onTint : t.color.text,
          fontFamily: t.font.family,
          fontSize: 15,
        }}
      >
        {title}
      </Text>
    </Pressable>
  );
}

/** M-A6 §2.2 — the sender picks who supplies the name; never the value itself. */
function NameSettings({
  field,
  dispatch,
}: {
  readonly field: EditorField;
  readonly dispatch: (a: EditorAction) => void;
}) {
  const t = useTheme();
  const mode = field.nameMode ?? 'SIGNER_PROFILE';
  return (
    <View style={styles.panelBody} accessibilityRole="radiogroup">
      <Choice
        testID="name-mode-profile"
        title="Signer’s name on the envelope"
        selected={mode === 'SIGNER_PROFILE'}
        onPress={() => dispatch({ type: 'setNameMode', key: field.key, mode: 'SIGNER_PROFILE' })}
      />
      <Choice
        testID="name-mode-entered"
        title="Signer types their name"
        selected={mode === 'SIGNER_ENTERED'}
        onPress={() => dispatch({ type: 'setNameMode', key: field.key, mode: 'SIGNER_ENTERED' })}
      />
      <Text style={{ color: t.color.textSecondary, fontFamily: t.font.family, fontSize: 14 }}>
        {mode === 'SIGNER_PROFILE'
          ? 'Aramo Sign fills in the recipient’s name. Nobody can change it.'
          : 'The signer enters their name when they sign.'}
      </Text>
    </View>
  );
}

/** M-A6 §2.3 — caption, group, group rule and minimum. */
function CheckboxSettings({
  field,
  fields,
  dispatch,
}: {
  readonly field: EditorField;
  readonly fields: readonly EditorField[];
  readonly dispatch: (a: EditorAction) => void;
}) {
  const t = useTheme();
  const [label, setLabel] = useState(field.label ?? '');
  const groups = [
    ...new Set(
      fields
        .filter(
          (f) =>
            f.type === 'CHECKBOX' &&
            f.recipientKey === field.recipientKey &&
            typeof f.groupKey === 'string',
        )
        .map((f) => f.groupKey as string),
    ),
  ];
  const size = groupMembers(fields, field.groupKey).length;
  const min = field.minSelected ?? 1;
  const secondary = { color: t.color.textSecondary, fontFamily: t.font.family, fontSize: 14 };
  return (
    <View style={styles.panelBody}>
      <Text style={secondary}>Label</Text>
      <TextInput
        testID="checkbox-label"
        value={label}
        onChangeText={setLabel}
        onEndEditing={() => dispatch({ type: 'setLabel', key: field.key, label })}
        onSubmitEditing={() => dispatch({ type: 'setLabel', key: field.key, label })}
        accessibilityLabel="Checkbox label"
        maxLength={MAX_LABEL}
        style={[
          styles.input,
          { borderColor: t.color.separator, color: t.color.text, backgroundColor: t.color.surface },
        ]}
      />
      <Text style={secondary}>Group</Text>
      <View style={styles.tools} accessibilityRole="radiogroup">
        <Choice
          title="No group"
          selected={!field.groupKey}
          onPress={() => dispatch({ type: 'setGroup', key: field.key, groupKey: null })}
        />
        {groups.map((g, i) => (
          <Choice
            key={g}
            title={`Group ${i + 1}`}
            selected={field.groupKey === g}
            onPress={() => dispatch({ type: 'setGroup', key: field.key, groupKey: g })}
          />
        ))}
        <Choice
          testID="checkbox-new-group"
          title="New group"
          selected={false}
          onPress={() =>
            dispatch({ type: 'setGroup', key: field.key, groupKey: nextGroupKey(fields) })
          }
        />
      </View>
      {field.groupKey ? (
        <>
          <View style={styles.tools} accessibilityRole="radiogroup">
            <Choice
              title="Select one"
              selected={field.groupRule === 'SELECT_ONE'}
              onPress={() => dispatch({ type: 'setGroupRule', key: field.key, rule: 'SELECT_ONE' })}
            />
            <Choice
              title="Select any"
              selected={field.groupRule !== 'SELECT_ONE'}
              onPress={() => dispatch({ type: 'setGroupRule', key: field.key, rule: 'SELECT_ANY' })}
            />
          </View>
          {field.groupRule !== 'SELECT_ONE' ? (
            <View style={styles.selHeader}>
              <Button
                title="−"
                variant="text"
                accessibilityLabel="Fewer required"
                disabled={min <= 1}
                onPress={() => dispatch({ type: 'setMinSelected', key: field.key, min: min - 1 })}
              />
              <Text
                style={[secondary, styles.grow]}
              >{`At least ${min} of ${size} checked when required`}</Text>
              <Button
                title="+"
                variant="text"
                accessibilityLabel="More required"
                disabled={min >= size}
                onPress={() => dispatch({ type: 'setMinSelected', key: field.key, min: min + 1 })}
              />
            </View>
          ) : (
            <Text style={secondary}>The signer checks exactly one box in this group.</Text>
          )}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, minHeight: 44, fontSize: 16 },
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
  canvasMin: { minHeight: '50%' },
  hscroll: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 16 },
  pages: { gap: 12 },
  loading: { height: 240, alignItems: 'center', justifyContent: 'center', padding: 24 },
  panel: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingTop: 10,
    maxHeight: '40%',
    gap: 10,
  },
  panelScroll: { flexGrow: 0, flexShrink: 1 },
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
  // M-A14 Sign Document
  selfCanvas: { paddingBottom: SELF_SHEET_OVERLAP + 28 },
  selfHscroll: { flexGrow: 1, justifyContent: 'center' },
  selfPages: { gap: 10 },
  selfToolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    paddingHorizontal: 16,
    backgroundColor: SELF_BACKDROP,
    borderBottomWidth: 1,
    borderBottomColor: '#E3E5EB',
    minHeight: 57,
  },
  selfFindBtn: { width: 40, height: 40, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  selfPageLabel: { position: 'absolute', left: 0, right: 0, textAlign: 'center', fontSize: 11, color: '#8A949C' },
  selfSheet: {
    marginTop: -SELF_SHEET_OVERLAP,
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    paddingTop: 10,
    shadowColor: SELF_INK,
    shadowOpacity: 0.12,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: -6 },
    elevation: 16,
    zIndex: 8,
  },
  selfHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: '#9A9EA8', alignSelf: 'center', marginBottom: 14 },
  selfExtra: { paddingHorizontal: 16, paddingBottom: 10, gap: 8 },
  selfTools: { paddingHorizontal: 6, paddingBottom: 6 },
  selfTool: { width: 74, alignItems: 'center', gap: 8 },
  selfToolCircle: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  selfToolRing: { borderWidth: 3, borderColor: 'rgba(13,27,76,0.18)' },
  selfToolLabel: { fontSize: 14.5, color: SELF_INK },
  selfHintRow: { alignItems: 'center', paddingHorizontal: 16, paddingTop: 2, gap: 4 },
  selfHint: { fontSize: 13, color: SELF_SECONDARY, textAlign: 'center' },
  selfCenter: { fontSize: 13, fontWeight: '600' },
  selfActions: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingTop: 14, paddingHorizontal: 16 },
  selfPageBtn: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: SELF_INK,
    shadowOpacity: 0.14,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  selfFinish: {
    width: 112,
    height: 50,
    borderRadius: 4,
    backgroundColor: SELF_INK,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selfFinishText: { color: '#FFFFFF', fontSize: 18, fontWeight: '500' },
});
