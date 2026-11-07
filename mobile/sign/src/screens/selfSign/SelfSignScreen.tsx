// M-A12 W1-A "Sign a document", rebuilt for M-A14 "Sign a Document" v2 (pixel reference
// a06–a10, b01, b02, a13–a17; LOCKED directive §1 items 3–4 and 8):
//   1. Add Documents (a06/a07): ‹ and ⋯, the "Auto suggest fields" switch (R-3, stored on
//      this device, default on), document cards (PDF icon, name, "N Pages", ⋯ menu), an
//      outlined "Add another document" that opens the same source sheet, a fixed Next.
//      Opened from the Add Documents sheet over Home, which hands the picked document over
//      in memory (selfSignHandoff); `start: 'templates'` opens the template picker.
//   2. Sign (a08–a10, b01, b02): ✕ (back to Add Documents, placed fields kept) and
//      "Sign / {file name}"; R-3 suggestions placed when the switch is on and nothing is
//      placed yet, with the green banner (Undo removes them, ✕ keeps them); otherwise the
//      Find toolbar; the R-6 tool row, ▲▼ and Finish (FieldEditor `selfSign`).
//      Finish without a signature: the toast "Add your signature before you finish" and
//      the Signature tool armed.
//   3. R-1: Finish → Finishing… while the real calls run (place, send, open the session),
//      the e-record consent, Finishing… while the fields are filled and the envelope is
//      completed (no timer; Try again on failure) → You're almost there (Email · Share ·
//      Save on the executed PDF) → Finish Signing → You've Signed → Done → Agreements,
//      where "Want to sign another document?" is offered. "You've Signed" never shows
//      before the server says COMPLETED; IN_PROGRESS keeps the "ready shortly" screen.
// No Recipients step and no invitation: the server makes the caller the only signer
// (`mode: "self"`), and the send allowance is never used (M-A12 D-1). Signing tokens stay
// in memory (features/selfSign). R-7: no Email / cloud source tiles and no AI controls.
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  InteractionManager,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import * as WebBrowser from 'expo-web-browser';

import type { GuestSigningSession } from '../../api/guestSigningClient';
import { newIdempotencyKey } from '../../api/workspaceClient';
import { useServices } from '../../app/ServicesContext';
import { biometricCapability, biometricConfirmPref, confirmLocally } from '../../auth/biometric';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { WEB_LINKS } from '../../config/env';
import type { EditorField } from '../../features/editor/editorReducer';
import { FieldEditor } from '../../features/editor/FieldEditor';
import type { AuthoringFieldType } from '../../features/editor/fieldTypes';
import { sizeScale } from '../../features/editor/fieldTypes';
import { fetchSourcePdf } from '../../features/editor/sourcePdf';
import { senderTextLayer } from '../../features/find/textLayerApi';
import type { FindDoc } from '../../features/find/useFind';
import { deleteDraftById } from '../../features/inbox/envelopeActions';
import { signKeys, useOnline, useSenderContext } from '../../features/inbox/queries';
import { CheckRow, EmptyState } from '../../features/inbox/ui';
import { DEFAULT_SETTINGS, useSignProfile, useSignSettings } from '../../features/profile/signProfile';
import { autoSuggestPref, suggestFields } from '../../features/selfSign/fieldSuggestions';
import { requestSignNext, takePendingSelfDocs } from '../../features/selfSign/selfSignHandoff';
import {
  acceptFillComplete,
  createAndUpload,
  createSelfEnvelope,
  createSelfFromTemplate,
  NO_PROGRESS,
  removeUploaded,
  selfSignRefusalCopy,
  sendAndOpen,
  startFromTemplate,
  type SelfProgress,
} from '../../features/selfSign/selfSignFlow';
import {
  canFinish,
  displayFill,
  docMenu,
  isChecked,
  isTextLike,
  moveDoc,
  pageCountLabel,
  removeDoc,
  renameDoc,
  SELF_COPY,
  SELF_KEY,
  selfSubject,
  textValue,
  totalPages,
  type SelfContext,
  type SelfDoc,
} from '../../features/selfSign/selfSignModel';
import { pickSelfDoc, type SelfSourceKey } from '../../features/selfSign/selfSignSources';
import {
  AddDocumentsSourceSheet,
  addSourceTiles,
  FILES_NOTE,
  FILES_NOTE_WORD,
  type AddSourceKey,
} from '../../features/send/AddDocumentsSheet';
import { wordUploadEnabled } from '../../features/send/fileValidation';
import { usePhotoEditor } from '../../features/send/photoEdit/PhotoEditor';
import { createSenderApi } from '../../features/send/senderApi';
import { templatesAvailable, type SenderTemplate } from '../../features/send/templates';
import { TextField } from '../../features/send/ui';
import { loadSavedMarks, type AdoptTarget, type SavedMarks } from '../../features/signing/adopt';
import { AdoptSignatureSheet, type AdoptResult } from '../../features/signing/AdoptSignatureSheet';
import { classifySigningError, SIGNING_COPY, type Disclosure } from '../../features/signing/signingApi';
import type { AdoptedMark } from '../../features/signing/signingMachine';
import { TemplateRows } from '../../features/templates/TemplateRows';
import { useTemplatesView } from '../../features/templates/useTemplates';
import type { RootStackParamList } from '../../navigation/types';
import { useTheme } from '../../theme';
import { AlmostThereScreen, FinishingScreen, YouSignedScreen } from './finish';

type Stage =
  | { kind: 'docs' }
  | { kind: 'place' }
  /** R-1: the real calls run; `failed` holds the message for Try again. */
  | { kind: 'finishing'; phase: 'prepare' | 'complete'; failed: string | null }
  | { kind: 'consent'; disclosure: Disclosure }
  | { kind: 'almost' }
  | { kind: 'ysigned' }
  /** The server answered IN_PROGRESS: today's "ready shortly" handling. */
  | { kind: 'pending' };

/** iOS dismisses one modal before presenting the next. */
const MODAL_HANDOFF_MS = 350;
const INK = '#0D1B4C';
const SECONDARY = '#4A5578';
const BACKDROP = '#F4F4F6';
const RULE = '#DADCE3';
const RULE_SOFT = '#E3E5EB';
const BANNER = '#C2EDD8';
const BANNER_BUTTON = '#A8DDC3';

const ICON = {
  back: 'M15 18l-6-6 6-6',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  close: 'M18 6 6 18M6 6l12 12',
  doc: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5',
  pdf: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6',
  check: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM8 12.5l2.7 2.7L16 10',
} as const;

function Glyph({ d, color = INK, size = 22, width = 2.2 }: { d: string; color?: string; size?: number; width?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round">
      <Path d={d} />
    </Svg>
  );
}

function CircleButton({
  d,
  label,
  onPress,
  testID,
}: {
  readonly d: string;
  readonly label: string;
  readonly onPress: () => void;
  readonly testID?: string;
}) {
  return (
    <Pressable testID={testID} onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={styles.circleBtn}>
      <Glyph d={d} size={22} width={d === ICON.more ? 3 : 2.4} />
    </Pressable>
  );
}

/** "3 Pages" (a06 card meta); null when the count is not known. */
export function pagesMeta(pages: SelfDoc['pages']): string | null {
  if (!pages) return null;
  return `${pages.length} ${pages.length === 1 ? 'Page' : 'Pages'}`;
}

/** "Lease.pdf" / "Lease.pdf +1" (the Sign header's second line). */
export function signFileName(docs: readonly SelfDoc[]): string {
  const first = docs[0];
  if (!first) return '';
  const name = /\.pdf$/i.test(first.filename) ? first.filename : `${first.title}.pdf`;
  return docs.length > 1 ? `${name} +${docs.length - 1}` : name;
}

/** "N field suggestion(s) placed. Review them below." */
export function suggestionBannerText(n: number): string {
  return `${n} ${n === 1 ? 'field suggestion' : 'field suggestions'} placed. Review them below.`;
}

export function SelfSignScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const qc = useQueryClient();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const route = useRoute<RouteProp<RootStackParamList, 'SelfSign'>>();
  const services = useServices();
  const { workspace, guest, kv } = services;
  const online = useOnline();
  const ctx = useSenderContext();
  const profile = useSignProfile();
  const settings = useSignSettings();
  // M-A13 #9 — chosen photos get a crop / straighten / rotate step before the PDF.
  const photoEditor = usePhotoEditor();

  // The document picked on the sheet over Home (read once, on the first render).
  const [initial] = useState(() => takePendingSelfDocs());
  const [stage, setStage] = useState<Stage>({ kind: 'docs' });
  const [docs, setDocs] = useState<SelfDoc[]>(() => initial.map((p) => p.doc));
  const [fields, setFields] = useState<readonly EditorField[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [adopted, setAdopted] = useState<SelfContext['adopted']>({});
  const [adoptFor, setAdoptFor] = useState<AdoptTarget | null>(null);
  const [saved, setSaved] = useState<SavedMarks | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const [tplMode, setTplMode] = useState<null | 'list' | SenderTemplate>(null);
  const [tplValues, setTplValues] = useState<Record<string, string>>({});
  const tplKey = useRef<string | null>(null);
  const [running, setRunning] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ key: string; title: string } | null>(null);
  const [consented, setConsented] = useState(false);
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // R-3 — the device preference (default on) and the suggestions now on the page.
  const [autoSuggest, setAutoSuggest] = useState(true);
  const [suggested, setSuggested] = useState<ReadonlySet<string>>(new Set());
  const [bannerOpen, setBannerOpen] = useState(false);
  // Remounts the editor when fields change from outside it (suggestions undone).
  const [editorKey, setEditorKey] = useState(0);
  const [armRequest, setArmRequest] = useState<{ type: AuthoringFieldType; id: number } | null>(null);
  /** The editor reads its fields once: remount it when they change from outside. */
  function remountEditor(): void {
    setArmRequest(null);
    setEditorKey((k) => k + 1);
  }
  const progress = useRef<SelfProgress>(NO_PROGRESS);
  const session = useRef<GuestSigningSession | null>(null);
  const stored = useRef(new Set<string>());
  const [envelopeId, setEnvelopeId] = useState<string | null>(null);

  const api = useMemo(() => createSenderApi(workspace), [workspace]);
  const fetchSource = useCallback(
    (envId: string, docId: string) =>
      fetchSourcePdf(
        { baseUrl: services.env.apiBaseUrl, fetch: (u, i) => fetch(u, i), session: services.session },
        envId,
        docId,
      ),
    [services],
  );
  const deps = useMemo(
    () => ({
      api,
      createSelf: createSelfEnvelope(workspace),
      openSession: (tok: string) => guest.open(tok),
      // M-A13 R-4 — a converted Word upload is read back as its PDF.
      fetchSource,
    }),
    [api, workspace, guest, fetchSource],
  );

  useEffect(() => {
    loadSavedMarks(workspace).then(setSaved, () => setSaved(null));
  }, [workspace]);

  // Opened from the Templates tile over Home: the picker opens once the screen is in.
  const startTemplates = route.params?.start === 'templates';
  useEffect(() => {
    if (!startTemplates) return;
    const h = InteractionManager.runAfterInteractions(() => setTplMode('list'));
    return () => h.cancel();
  }, [startTemplates]);

  useEffect(() => {
    let live = true;
    void autoSuggestPref.get(kv).then((on) => live && setAutoSuggest(on));
    return () => {
      live = false;
    };
  }, [kv]);

  // Leaving before Finish sent anything: forget the token and drop the unsent draft.
  useEffect(
    () => () => {
      session.current?.discard();
      const p = progress.current;
      if (p.envelopeId && !p.sent) void deleteDraftById(workspace, p.envelopeId).catch(() => undefined);
    },
    [workspace],
  );

  const name = ctx.data?.user.display_name ?? '';
  const selfCtx: SelfContext = {
    profile: profile.data ?? null,
    email: ctx.data?.user.email ?? null,
    fallbackName: name,
    dateFormat: settings.data?.date_format ?? DEFAULT_SETTINGS.date_format,
    adopted,
    today: new Date(),
  };
  const wordAllowed = wordUploadEnabled(ctx.data);

  // ── 1. Documents ──
  async function add(key: SelfSourceKey): Promise<void> {
    setPickError(null);
    setError(null);
    setRunning(true);
    try {
      const r = await pickSelfDoc(key, { editPhoto: photoEditor.edit, wordAllowed });
      if (r.kind === 'cancelled') return;
      if (r.kind === 'refused') {
        setPickError(r.message);
        return;
      }
      setDocs((d) => [...d, r.doc]);
      setPicking(false);
    } finally {
      setRunning(false);
    }
  }

  async function remove(key: string): Promise<void> {
    const d = docs.find((x) => x.key === key);
    setMenuFor(null);
    if (d?.serverId) {
      if (!online) {
        setError(SELF_COPY.offline);
        return;
      }
      try {
        progress.current = await removeUploaded(deps, progress.current, d.serverId);
      } catch {
        setError(SELF_COPY.uploadFailed);
        return;
      }
    }
    setDocs((x) => removeDoc(x, key));
    setFields((f) => f.filter((x) => x.docKey !== key));
    remountEditor();
  }

  async function next(): Promise<void> {
    if (docs.length === 0) return;
    if (!online) {
      setError(SELF_COPY.offline);
      return;
    }
    setError(null);
    setRunning(true);
    try {
      const r = await createAndUpload(deps, progress.current, docs, selfSubject(docs), (p, d) => {
        progress.current = p;
        setDocs([...d]);
      });
      progress.current = r.progress;
      setEnvelopeId(r.progress.envelopeId);
      setDocs(r.docs);
      // R-3 — suggestions only while the switch is on and nothing is placed yet.
      if (autoSuggest && fields.length === 0 && r.progress.envelopeId) {
        const s = await suggestFields(workspace, r.progress.envelopeId, r.docs);
        if (s.length > 0) {
          setFields(s);
          setSuggested(new Set(s.map((f) => f.key)));
          setBannerOpen(true);
          remountEditor();
        }
      }
      setStage({ kind: 'place' });
    } catch (e) {
      setError(selfSignRefusalCopy(e, SELF_COPY.uploadFailed));
    } finally {
      setRunning(false);
    }
  }

  function toggleAutoSuggest(on: boolean): void {
    setAutoSuggest(on);
    void autoSuggestPref.set(kv, on).catch(() => undefined);
  }

  // Templates as a source: the template's documents and fields, for the caller only.
  const templatesAllowed = templatesAvailable(ctx.data ?? null);
  const templatesOn = templatesAllowed && docs.length === 0 && envelopeId === null;
  const templates = useTemplatesView(tplMode !== null && templatesAllowed);
  function closeTemplates(): void {
    setTplMode(null);
    setTplValues({});
    tplKey.current = null;
  }
  async function startTemplate(tpl: SenderTemplate): Promise<void> {
    if (!online) {
      setError(SELF_COPY.offline);
      return;
    }
    setError(null);
    setRunning(true);
    // One key per "Use" intent, reused on a retry of the same template.
    tplKey.current ??= newIdempotencyKey();
    try {
      const r = await startFromTemplate(
        { createFromTemplate: createSelfFromTemplate(workspace), fetchSource },
        { templateId: tpl.id, values: tplValues, idempotencyKey: tplKey.current },
      );
      progress.current = r.progress;
      setEnvelopeId(r.progress.envelopeId);
      setDocs(r.docs);
      setFields(r.fields);
      remountEditor();
      closeTemplates();
      setStage({ kind: 'place' });
    } catch (e) {
      setError(selfSignRefusalCopy(e, SELF_COPY.uploadFailed));
    } finally {
      setRunning(false);
    }
  }

  function pickSource(key: AddSourceKey): void {
    if (key === 'templates') {
      setPicking(false);
      // iOS presents one modal at a time: open the picker once the sheet has gone.
      setTimeout(() => setTplMode('list'), Platform.OS === 'ios' ? MODAL_HANDOFF_MS : 0);
      return;
    }
    void add(key);
  }

  // ── 2. Place and fill ──
  const editorDocs = useMemo(() => docs.map((d) => ({ key: d.key, title: d.title })), [docs]);
  const recipients = useMemo(() => [{ key: SELF_KEY, name: name || 'You' }], [name]);
  const loadAsset = useCallback(
    async (key: string) => {
      const d = docs.find((x) => x.key === key);
      if (!d?.base64 || !d.pages) throw new Error('document not on this phone');
      return { base64: d.base64, pages: d.pages };
    },
    [docs],
  );
  const findDocs = useMemo<readonly FindDoc[]>(
    () =>
      docs.map((d) => ({
        docKey: d.key,
        load: envelopeId && d.serverId ? () => senderTextLayer(workspace, envelopeId, d.serverId as string) : null,
      })),
    [docs, envelopeId, workspace],
  );

  // M-A13 #3 — adopting that started from picking the tool places the mark when done.
  const placeAfterAdopt = useRef(false);
  const [placeRequest, setPlaceRequest] = useState<{ type: AdoptTarget; id: number } | null>(null);
  const onPickTool = useCallback(
    (type: string) => {
      if ((type === 'SIGNATURE' || type === 'INITIALS') && !adopted[type]) {
        placeAfterAdopt.current = true;
        setAdoptFor(type);
        toast.show(type === 'INITIALS' ? 'Adopt your initials first' : 'Adopt your signature first');
        return false;
      }
      return true;
    },
    [adopted, toast],
  );
  // §1 item 4 — a signature box with no adopted mark opens the adopt sheet when tapped.
  const onFieldTap = useCallback(
    (f: EditorField) => {
      if ((f.type === 'SIGNATURE' || f.type === 'INITIALS') && !adopted[f.type]) setAdoptFor(f.type);
    },
    [adopted],
  );
  const onFieldsChange = useCallback(
    (next: readonly EditorField[]) => {
      // A signature placed with the armed tool and no adopted mark yet: adopt it now.
      const known = new Set(fields.map((f) => f.key));
      const added = next.find((f) => !known.has(f.key) && (f.type === 'SIGNATURE' || f.type === 'INITIALS'));
      if (added && !adopted[added.type as AdoptTarget]) setAdoptFor(added.type as AdoptTarget);
      setFields(next);
    },
    [adopted, fields],
  );

  function onAdopted(r: AdoptResult): void {
    const target = adoptFor ?? 'SIGNATURE';
    setAdopted((a) => ({ ...a, [target]: r.mark as AdoptedMark }));
    setAdoptFor(null);
    if (placeAfterAdopt.current) setPlaceRequest((p) => ({ type: target, id: (p?.id ?? 0) + 1 }));
    placeAfterAdopt.current = false;
  }

  // R-3 banner — Undo removes the suggested fields; ✕ keeps them.
  const suggestedOnPage = fields.filter((f) => suggested.has(f.key)).length;
  const showBanner = bannerOpen && suggestedOnPage > 0;
  function undoSuggestions(): void {
    setFields((f) => f.filter((x) => !suggested.has(x.key)));
    setSuggested(new Set());
    setBannerOpen(false);
    remountEditor();
  }
  function keepSuggestions(): void {
    setSuggested(new Set());
    setBannerOpen(false);
  }

  const renderValue = (f: EditorField) => {
    if (f.type === 'CHECKBOX') {
      const on = isChecked(f, edits);
      return (
        <Button
          testID="self-toggle-check"
          variant="secondary"
          title={on ? 'Checked ✓' : 'Not checked'}
          onPress={() => setEdits((e) => ({ ...e, [f.key]: on ? 'false' : 'true' }))}
        />
      );
    }
    if (f.type === 'SIGNATURE' || f.type === 'INITIALS') {
      return adopted[f.type] ? (
        <Button
          variant="secondary"
          title={f.type === 'SIGNATURE' ? 'Change signature' : 'Change initials'}
          onPress={() => setAdoptFor(f.type as AdoptTarget)}
        />
      ) : null;
    }
    if (f.type === 'SIGNER_NAME' && (f.nameMode ?? 'SIGNER_PROFILE') === 'SIGNER_PROFILE') return null;
    if (!isTextLike(f.type)) return null;
    return (
      <TextInput
        testID="self-value-input"
        value={textValue(f, selfCtx, edits)}
        onChangeText={(v) => setEdits((e) => ({ ...e, [f.key]: v }))}
        placeholder="Type here"
        placeholderTextColor={t.color.textTertiary}
        accessibilityLabel="Field value"
        maxLength={500}
        autoCapitalize={f.type === 'EMAIL' ? 'none' : 'sentences'}
        keyboardType={f.type === 'EMAIL' ? 'email-address' : 'default'}
        style={[styles.input, { borderColor: RULE, color: INK, backgroundColor: '#FFFFFF' }]}
      />
    );
  };

  // ── 3. Finish (R-1) ──
  function onFinish(): void {
    if (!fields.some((f) => f.type === 'SIGNATURE')) {
      toast.show(SELF_COPY.needSignature);
      setArmRequest((a) => ({ type: 'SIGNATURE', id: (a?.id ?? 0) + 1 }));
      return;
    }
    const check = canFinish(fields, selfCtx, edits);
    if (!check.ok) {
      toast.show(check.message ?? SELF_COPY.needSignature);
      const f = fields.find((x) => x.key === check.fieldKey);
      if (f && (f.type === 'SIGNATURE' || f.type === 'INITIALS') && !adopted[f.type]) setAdoptFor(f.type);
      return;
    }
    if (!online) {
      setError(SELF_COPY.offline);
      return;
    }
    void prepare();
  }

  async function prepare(): Promise<void> {
    setError(null);
    setStage({ kind: 'finishing', phase: 'prepare', failed: null });
    try {
      const r = await sendAndOpen(deps, progress.current, fields, docs, selfSubject(docs), (p) => {
        progress.current = p;
      });
      progress.current = r.progress;
      session.current?.discard();
      session.current = r.session;
      setConsented(false);
      setStage({ kind: 'consent', disclosure: r.disclosure });
      void qc.invalidateQueries({ queryKey: signKeys.senderList });
    } catch (e) {
      setStage({ kind: 'finishing', phase: 'prepare', failed: selfSignRefusalCopy(e, SELF_COPY.finishFailed) });
    }
  }

  const lastDisclosure = useRef<Disclosure | null>(null);
  async function accept(disclosure: Disclosure): Promise<void> {
    const s = session.current;
    if (!s) return;
    const pref = await biometricConfirmPref.get(kv).catch(() => false);
    if (pref) {
      const cap = await biometricCapability().catch(() => null);
      if (cap?.available) {
        const ok = await confirmLocally('Confirm it’s you to finish signing').catch(() => false);
        if (!ok) return;
      }
    }
    await complete(disclosure);
  }

  async function complete(disclosure: Disclosure): Promise<void> {
    const s = session.current;
    if (!s) return;
    lastDisclosure.current = disclosure;
    setStage({ kind: 'finishing', phase: 'complete', failed: null });
    try {
      const r = await acceptFillComplete(s, disclosure, fields, docs, selfCtx, edits, stored.current, (id) =>
        stored.current.add(id),
      );
      s.discard();
      session.current = null;
      void qc.invalidateQueries({ queryKey: signKeys.senderList });
      // R-1 — "You've Signed" only once the server says COMPLETED.
      setStage(r.envelopeStatus === 'COMPLETED' ? { kind: 'almost' } : { kind: 'pending' });
    } catch (e) {
      const kind = classifySigningError(e);
      setStage({
        kind: 'finishing',
        phase: 'complete',
        failed: kind === 'ended' ? SIGNING_COPY.ended : SELF_COPY.finishFailed,
      });
    }
  }

  function retry(): void {
    if (stage.kind !== 'finishing') return;
    if (!online) {
      setStage({ ...stage, failed: SELF_COPY.offline });
      return;
    }
    if (stage.phase === 'prepare') void prepare();
    else if (lastDisclosure.current && session.current) void complete(lastDisclosure.current);
    else void prepare();
  }

  function cancelFinishing(): void {
    if (stage.kind !== 'finishing') return;
    if (stage.phase === 'complete' && lastDisclosure.current && session.current) {
      setStage({ kind: 'consent', disclosure: lastDisclosure.current });
    } else setStage({ kind: 'place' });
  }

  const close = () => navigation.goBack();
  // §1 item 8 — Done: Agreements (All), with "Want to sign another document?" offered.
  const done = () => {
    requestSignNext();
    navigation.navigate('Main', { screen: 'Agreements', params: { filter: 'all' } });
  };
  const font = { fontFamily: t.font.family };
  const textStyle = { color: t.color.text, fontFamily: t.font.family };
  const secondary = { color: t.color.textSecondary, fontFamily: t.font.family };
  const headerTop = insets.top + 8;

  // ── Render ──
  if (stage.kind === 'finishing') {
    return (
      <View style={styles.fill} testID="self-working">
        <FinishingScreen
          state={stage.failed ? 'failed' : 'working'}
          {...(stage.failed ? { message: stage.failed } : {})}
          onRetry={retry}
          onCancel={cancelFinishing}
        />
      </View>
    );
  }

  if (stage.kind === 'almost' && envelopeId) {
    return (
      <View style={styles.fill} testID="self-almost">
        <AlmostThereScreen
          envelopeId={envelopeId}
          documentTitle={selfSubject(docs)}
          onFinishSigning={() => setStage({ kind: 'ysigned' })}
        />
      </View>
    );
  }

  if (stage.kind === 'ysigned' && envelopeId) {
    const id = envelopeId;
    return (
      <View style={styles.fill} testID="self-done">
        <YouSignedScreen
          envelopeId={id}
          onViewSigned={() => navigation.navigate('DocumentViewer', { envelopeId: id, kind: 'executed' })}
          onViewCertificate={() => navigation.navigate('DocumentViewer', { envelopeId: id, kind: 'certificate' })}
          onDone={done}
        />
      </View>
    );
  }

  if (stage.kind === 'pending' || stage.kind === 'almost' || stage.kind === 'ysigned') {
    return (
      <View style={[styles.end, { backgroundColor: '#FFFFFF', paddingTop: insets.top + 24 }]} testID="self-pending">
        <Text accessibilityRole="header" style={[styles.endTitle, { color: INK }, font]}>
          Your signature is saved
        </Text>
        <Text style={[styles.endBody, { color: SECONDARY }, font]}>
          The signed copy will be ready shortly. It will be saved in your Aramo Sign account.
        </Text>
        <Button testID="self-pending-done" title="Done" variant="secondary" onPress={done} />
      </View>
    );
  }

  if (stage.kind === 'consent') {
    const d = stage.disclosure;
    return (
      <ScrollView
        style={{ flex: 1, backgroundColor: t.color.screen }}
        contentContainerStyle={[styles.consent, { paddingTop: insets.top + 16 }]}
        testID="self-consent"
      >
        <Text accessibilityRole="header" style={[textStyle, t.type.detailTitle]}>
          {selfSubject(docs)}
        </Text>
        <CheckRow
          testID="self-consent-check"
          checked={consented}
          onToggle={() => setConsented((c) => !c)}
          accessibilityLabel="I agree to use electronic records and signatures"
        >
          <Text style={[textStyle, { fontSize: 15, lineHeight: 21 }]}>
            I agree to use electronic records and signatures.{' '}
            <Text accessibilityRole="link" onPress={() => setDisclosureOpen(true)} style={{ color: t.color.accent, fontWeight: '600' }}>
              Read the disclosure
            </Text>
          </Text>
        </CheckRow>
        {error ? <Banner body={error} /> : null}
        <Button
          testID="self-consent-continue"
          title="Finish"
          disabled={!consented || !online}
          onPress={() => void accept(d)}
        />
        <Sheet visible={disclosureOpen} onClose={() => setDisclosureOpen(false)} title="Electronic records and signatures">
          <Text style={[secondary, { fontSize: 13 }]}>{`Version ${d.disclosure_version}`}</Text>
          <Text style={[textStyle, { fontSize: 15, lineHeight: 22 }]}>{d.text}</Text>
          <Button title="Close" variant="secondary" onPress={() => setDisclosureOpen(false)} />
        </Sheet>
      </ScrollView>
    );
  }

  if (stage.kind === 'place') {
    const banner = showBanner ? (
      <View testID="self-suggest-banner" style={styles.banner} accessibilityLiveRegion="polite">
        <Glyph d={ICON.check} color="#1E7A50" size={26} width={1.8} />
        <Text style={[styles.bannerText, font]}>{suggestionBannerText(suggestedOnPage)}</Text>
        <Pressable testID="self-suggest-undo" onPress={undoSuggestions} accessibilityRole="button" style={styles.bannerUndo}>
          <Text style={[styles.bannerUndoText, font]}>Undo</Text>
        </Pressable>
        <Pressable
          testID="self-suggest-dismiss"
          onPress={keepSuggestions}
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          hitSlop={6}
          style={styles.bannerClose}
        >
          <Glyph d={ICON.close} size={20} />
        </Pressable>
      </View>
    ) : null;
    return (
      <View style={{ flex: 1, backgroundColor: BACKDROP }} testID="self-place">
        <View style={[styles.head, { paddingTop: headerTop, paddingBottom: 10 }]}>
          <CircleButton
            testID="self-place-close"
            d={ICON.close}
            label="Close"
            onPress={() => {
              setArmRequest(null);
              setStage({ kind: 'docs' });
            }}
          />
          <View style={styles.headCenter}>
            <Text accessibilityRole="header" style={[styles.signTitle, font]}>
              Sign
            </Text>
            <Text testID="self-file-name" numberOfLines={1} style={[styles.signFile, font]}>
              {signFileName(docs)}
            </Text>
          </View>
          <View style={styles.headSide} />
        </View>
        {error ? (
          <View style={{ padding: 12 }}>
            <Banner body={error} />
          </View>
        ) : null}
        <FieldEditor
          key={editorKey}
          documents={editorDocs}
          recipients={recipients}
          initialFields={fields}
          loadAsset={loadAsset}
          onFieldsChange={onFieldsChange}
          fillFor={(f) => displayFill(f, selfCtx, edits)}
          onPickTool={onPickTool}
          renderSelectionExtra={renderValue}
          fieldScale={sizeScale(settings.data?.default_field_size)}
          findDocs={findDocs}
          hideRecipients
          placeRequest={placeRequest}
          bottomInset={insets.bottom}
          selfSign={{
            banner,
            onFinish,
            finishDisabled: !online,
            armRequest,
            onFieldTap,
          }}
        />
        <AdoptSignatureSheet
          visible={adoptFor !== null}
          target={adoptFor ?? 'SIGNATURE'}
          mode="sign"
          defaultName={name}
          canSaveDefault={false}
          saved={adoptFor === 'INITIALS' ? saved?.initials : saved?.signature}
          onAdopt={onAdopted}
          onClose={() => {
            placeAfterAdopt.current = false;
            setAdoptFor(null);
          }}
        />
      </View>
    );
  }

  // ── Add Documents (a06, a07) ──
  const menu = menuFor ? docMenu(docs, menuFor) : null;
  const nextOff = docs.length === 0 || running || !online;
  return (
    <View style={{ flex: 1, backgroundColor: BACKDROP }} testID="self-docs">
      <View style={[styles.head, { paddingTop: headerTop, paddingBottom: 12 }]}>
        <CircleButton testID="self-back" d={ICON.back} label="Back" onPress={close} />
        <View style={styles.headCenter}>
          <Text accessibilityRole="header" style={[styles.docsTitle, font]}>
            Add Documents
          </Text>
        </View>
        <CircleButton testID="self-more" d={ICON.more} label="More" onPress={() => setMoreOpen(true)} />
      </View>
      <View style={styles.suggestRow}>
        <Text style={[styles.suggestLabel, font]} nativeID="auto-suggest-label">
          Auto suggest fields
        </Text>
        <Switch
          testID="self-auto-suggest"
          value={autoSuggest}
          onValueChange={toggleAutoSuggest}
          accessibilityLabel="Auto suggest fields"
          trackColor={{ false: '#C9CDD8', true: INK }}
          thumbColor={Platform.OS === 'android' ? '#FFFFFF' : undefined}
          ios_backgroundColor="#C9CDD8"
        />
      </View>
      <ScrollView style={styles.docsBody} contentContainerStyle={styles.docs}>
        {!online ? <Banner tone="offline" body={SELF_COPY.offline} /> : null}
        {docs.map((d, i) => (
          <View key={d.key} testID={`self-doc-${i}`} style={styles.card}>
            <View style={styles.pdfIcon}>
              <Glyph d={ICON.pdf} color="#D93025" size={34} width={1.8} />
              <Text style={styles.pdfTag}>PDF</Text>
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[styles.cardTitle, font]} numberOfLines={1}>
                {d.title}
              </Text>
              {pagesMeta(d.pages) ? <Text style={[styles.cardMeta, font]}>{pagesMeta(d.pages)}</Text> : null}
            </View>
            <Pressable
              testID={`self-doc-menu-${i}`}
              onPress={() => setMenuFor(d.key)}
              accessibilityRole="button"
              accessibilityLabel={`More for ${d.title}`}
              hitSlop={8}
              style={styles.cardMenu}
            >
              <Glyph d={ICON.more} width={3} />
            </Pressable>
          </View>
        ))}
        <Pressable
          testID="self-add"
          onPress={() => {
            setPickError(null);
            setPicking(true);
          }}
          accessibilityRole="button"
          style={styles.addAnother}
        >
          <Glyph d={ICON.doc} size={22} width={1.8} />
          <Text style={[styles.addAnotherText, font]}>{docs.length ? 'Add another document' : 'Add a document'}</Text>
        </Pressable>
        {error ? (
          <Text accessibilityRole="alert" style={{ color: t.color.destructive, fontSize: 14 }}>
            {error}
          </Text>
        ) : null}
      </ScrollView>
      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 14) }]}>
        <Pressable
          testID="self-next"
          onPress={() => void next()}
          disabled={nextOff}
          accessibilityRole="button"
          accessibilityLabel="Next"
          accessibilityState={{ disabled: nextOff, busy: running }}
          style={[styles.next, { opacity: nextOff && !running ? 0.4 : 1 }]}
        >
          {running ? <ActivityIndicator color="#FFFFFF" /> : <Text style={[styles.nextText, font]}>Next</Text>}
        </Pressable>
      </View>
      <AddDocumentsSourceSheet
        visible={picking}
        tiles={addSourceTiles(templatesOn)}
        onPick={pickSource}
        onClose={() => setPicking(false)}
        busy={running}
        error={pickError}
        filesNote={wordAllowed ? FILES_NOTE_WORD : FILES_NOTE}
      >
        {photoEditor.element}
      </AddDocumentsSourceSheet>
      <Sheet
        visible={tplMode !== null}
        onClose={closeTemplates}
        title={tplMode === null || tplMode === 'list' ? 'Templates' : tplMode.name}
      >
        {tplMode === 'list' ? (
          templates.view.kind === 'list' ? (
            <TemplateRows rows={templates.view.rows} onUse={(tpl) => setTplMode(tpl)} disabled={running} />
          ) : templates.view.kind === 'loading' ? (
            <ActivityIndicator color={t.color.accent} accessibilityLabel="Loading templates" />
          ) : (
            <EmptyState
              title="No templates"
              body={'message' in templates.view ? templates.view.message : 'Templates couldn’t be loaded.'}
            />
          )
        ) : tplMode ? (
          <View style={styles.tiles} testID="self-template-form">
            {tplMode.senderVariables.map((v) => (
              <TextField
                key={v.key}
                label={v.label}
                value={tplValues[v.key] ?? ''}
                onChangeText={(x) => setTplValues((m) => ({ ...m, [v.key]: x }))}
              />
            ))}
            <Button
              testID="self-template-use"
              title="Use template"
              busy={running}
              disabled={running || !online || tplMode.senderVariables.some((v) => !(tplValues[v.key] ?? '').trim())}
              onPress={() => void startTemplate(tplMode)}
            />
          </View>
        ) : null}
        {error && tplMode !== null ? (
          <Text accessibilityRole="alert" style={{ color: t.color.destructive, fontSize: 14 }}>
            {error}
          </Text>
        ) : null}
        <Button
          title={tplMode === 'list' ? 'Close' : 'Back'}
          variant="text"
          onPress={() => (tplMode === 'list' ? closeTemplates() : setTplMode('list'))}
        />
      </Sheet>
      <Sheet visible={moreOpen} onClose={() => setMoreOpen(false)} title="More">
        <Button
          testID="self-more-details"
          title="Document details"
          variant="secondary"
          onPress={() => {
            setMoreOpen(false);
            setDetailsOpen(true);
          }}
        />
        <Button
          testID="self-more-help"
          title="Help"
          variant="secondary"
          onPress={() => {
            setMoreOpen(false);
            void WebBrowser.openBrowserAsync(WEB_LINKS.help).catch(() => undefined);
          }}
        />
        <Button title="Close" variant="text" onPress={() => setMoreOpen(false)} />
      </Sheet>
      <Sheet visible={detailsOpen} onClose={() => setDetailsOpen(false)} title="Document details">
        {docs.map((d) => (
          <Text key={d.key} style={[textStyle, { fontSize: 15 }]}>
            {[d.title, pageCountLabel(d.pages)].filter(Boolean).join(' · ')}
          </Text>
        ))}
        <Text style={[secondary, { fontSize: 14 }]}>
          {`${totalPages(docs)} ${totalPages(docs) === 1 ? 'page' : 'pages'}. Only you sign this document. Nobody is emailed.`}
        </Text>
        <Button title="Close" variant="text" onPress={() => setDetailsOpen(false)} />
      </Sheet>
      <Sheet visible={menuFor !== null && renaming === null} onClose={() => setMenuFor(null)} title="Document">
        {menu?.rename ? (
          <Button
            testID="self-doc-rename"
            title="Rename"
            variant="secondary"
            onPress={() => {
              const d = docs.find((x) => x.key === menuFor);
              if (d) setRenaming({ key: d.key, title: d.title });
            }}
          />
        ) : null}
        {menu?.up ? (
          <Button
            testID="self-doc-up"
            title="Move up"
            variant="secondary"
            onPress={() => {
              if (menuFor) setDocs((d) => moveDoc(d, menuFor, -1));
              setMenuFor(null);
            }}
          />
        ) : null}
        {menu?.down ? (
          <Button
            testID="self-doc-down"
            title="Move down"
            variant="secondary"
            onPress={() => {
              if (menuFor) setDocs((d) => moveDoc(d, menuFor, 1));
              setMenuFor(null);
            }}
          />
        ) : null}
        <Button testID="self-doc-remove" title="Remove" variant="destructive" onPress={() => menuFor && void remove(menuFor)} />
        <Button title="Cancel" variant="text" onPress={() => setMenuFor(null)} />
      </Sheet>
      <Sheet visible={renaming !== null} onClose={() => setRenaming(null)} title="Rename">
        <TextInput
          testID="self-rename-input"
          value={renaming?.title ?? ''}
          onChangeText={(v) => setRenaming((r) => (r ? { ...r, title: v } : r))}
          accessibilityLabel="Document name"
          autoFocus
          maxLength={200}
          style={[styles.input, { borderColor: t.color.separator, color: t.color.text, backgroundColor: t.color.surface }]}
        />
        <Button
          testID="self-rename-save"
          title="Save"
          disabled={!renaming?.title.trim()}
          onPress={() => {
            if (renaming) setDocs((d) => renameDoc(d, renaming.key, renaming.title));
            setRenaming(null);
            setMenuFor(null);
          }}
        />
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  end: { flex: 1, padding: 24, gap: 14, justifyContent: 'center' },
  endTitle: { fontSize: 26, fontWeight: '700', textAlign: 'center' },
  endBody: { fontSize: 17, lineHeight: 25, textAlign: 'center' },
  consent: { padding: 16, gap: 16 },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: RULE,
  },
  headCenter: { flex: 1, minWidth: 0, alignItems: 'center', paddingHorizontal: 6 },
  headSide: { width: 44, height: 44 },
  circleBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: INK,
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  docsTitle: { fontSize: 18, fontWeight: '600', color: INK },
  signTitle: { fontSize: 17, fontWeight: '500', color: INK },
  signFile: { fontSize: 14.5, color: INK, marginTop: 2 },
  suggestRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 14,
    paddingHorizontal: 16,
    backgroundColor: '#FFFFFF',
  },
  suggestLabel: { fontSize: 16, color: INK },
  docsBody: { flex: 1, borderTopWidth: 1, borderTopColor: RULE_SOFT },
  docs: { padding: 14, paddingBottom: 20, gap: 12 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    backgroundColor: '#FFFFFF',
    borderRadius: 4,
    paddingVertical: 18,
    paddingLeft: 18,
    paddingRight: 14,
    shadowColor: INK,
    shadowOpacity: 0.12,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  pdfIcon: { width: 30, height: 34, alignItems: 'center', justifyContent: 'center' },
  pdfTag: {
    position: 'absolute',
    left: -4,
    top: 13,
    backgroundColor: '#D93025',
    color: '#FFFFFF',
    fontSize: 8.5,
    fontWeight: '700',
    paddingHorizontal: 3,
    paddingVertical: 1,
    borderRadius: 2,
    overflow: 'hidden',
  },
  cardTitle: { fontSize: 16, fontWeight: '500', color: INK },
  cardMeta: { fontSize: 14, color: SECONDARY, marginTop: 4 },
  cardMenu: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  addAnother: {
    height: 68,
    borderWidth: 1.5,
    borderColor: INK,
    borderRadius: 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  addAnotherText: { fontSize: 17, fontWeight: '500', color: INK },
  footer: {
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderTopColor: RULE_SOFT,
    paddingTop: 14,
    paddingHorizontal: 16,
    alignItems: 'flex-end',
  },
  next: { width: 134, height: 50, borderRadius: 4, backgroundColor: INK, alignItems: 'center', justifyContent: 'center' },
  nextText: { color: '#FFFFFF', fontSize: 18, fontWeight: '500' },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    paddingLeft: 16,
    paddingRight: 12,
    backgroundColor: BANNER,
  },
  bannerText: { flex: 1, fontSize: 16, lineHeight: 21, color: INK },
  bannerUndo: { height: 34, borderRadius: 4, backgroundColor: BANNER_BUTTON, paddingHorizontal: 20, justifyContent: 'center' },
  bannerUndoText: { fontSize: 16, color: INK },
  bannerClose: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  tiles: { gap: 10 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, minHeight: 44, fontSize: 16 },
});
