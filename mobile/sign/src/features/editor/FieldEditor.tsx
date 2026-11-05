// Step 3 "Fields" — the full field editor (handoff §4.6; directive §5 "Fields"; §10).
//   Toolbar: signer chips (dot, first name, field count), Undo (30 steps), zoom
//            100 / 150 / 200 %. Wraps at large text sizes.
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
import { FIELD_TYPE_SPECS, MAX_LABEL, toolFieldTypes, type AuthoringFieldType } from './fieldTypes';
import { scaleFor, screenToEditorPoint, type PageSize } from './geometry';
import { FindBar, HighlightOverlay, PageNavigator } from '../find/FindBar';
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
  fillFor,
  onPickTool,
  renderSelectionExtra,
  fieldScale = 1,
  findDocs,
  hideRecipients = false,
  toolbarExtra,
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
  const CANVAS_TOP = 16;
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
      scale: fieldScale,
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

      {/* Canvas */}
      <ScrollView
        ref={scrollRef}
        onLayout={(e: LayoutChangeEvent) => (viewport.current = e.nativeEvent.layout.height)}
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
          <View style={styles.panelBody}>
            <Text style={[secondary, styles.hint]} accessibilityLiveRegion="polite">
              {hint}
            </Text>
            <View style={styles.tools}>
              {toolFieldTypes().map((type) => (
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
