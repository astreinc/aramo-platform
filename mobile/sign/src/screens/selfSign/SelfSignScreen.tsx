// M-A12 W1-A "Sign a document" (prototype "Sign a document"): its own flow, opened from
// "+ › Sign a document".
//   1. Documents: Scan / Photos / Files, with the page count and a per-document menu
//      (Rename, Move up / down, Remove — W1-B);
//   2. one editor screen: each placed field is filled at once (the adopted signature and
//      initials; date, name and the profile fields from the user's Sign profile, editable);
//   3. the disclosure; 4. Finish; 5. the completed screen (Share PDF, certificate).
// Templates (while the backend allows them) start the flow instead: the server creates the
// self envelope from the template (`mode: "self"`), with its documents and fields for the
// caller, and the editor opens on them. M-A12 D-1: nothing on the device disables this
// flow (not `can_send`, not the allowance); a server refusal is shown when one comes back.
// No Recipients step and no invitation: the server makes the caller the only signer
// (`mode: "self"`), and the send allowance is never used, so "no sends left" never
// blocks this flow (M-A12 D-1). Signing tokens stay in memory (features/selfSign).
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';

import type { GuestSigningSession } from '../../api/guestSigningClient';
import { useServices } from '../../app/ServicesContext';
import { biometricCapability, biometricConfirmPref, confirmLocally } from '../../auth/biometric';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { WEB_LINKS } from '../../config/env';
import type { EditorField } from '../../features/editor/editorReducer';
import { FieldEditor } from '../../features/editor/FieldEditor';
import { sizeScale } from '../../features/editor/fieldTypes';
import { senderTextLayer } from '../../features/find/textLayerApi';
import type { FindDoc } from '../../features/find/useFind';
import { deleteDraftById } from '../../features/inbox/envelopeActions';
import { signKeys, useOnline, useSenderContext } from '../../features/inbox/queries';
import { CheckRow, EmptyState } from '../../features/inbox/ui';
import { DEFAULT_SETTINGS, useSignProfile, useSignSettings } from '../../features/profile/signProfile';
import {
  acceptFillComplete,
  createAndUpload,
  createSelfEnvelope,
  NO_PROGRESS,
  pagesOf,
  removeUploaded,
  selfSignRefusalCopy,
  sendAndOpen,
  startFromTemplate,
  createSelfFromTemplate,
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
import { addSourceTiles, SOURCE_UNAVAILABLE } from '../../features/send/AddDocumentsSheet';
import { templatesAvailable, type SenderTemplate } from '../../features/send/templates';
import { TextField } from '../../features/send/ui';
import { fetchSourcePdf } from '../../features/editor/sourcePdf';
import { TemplateRows } from '../../features/templates/TemplateRows';
import { useTemplatesView } from '../../features/templates/useTemplates';
import { newIdempotencyKey } from '../../api/workspaceClient';
import { usePhotoEditor } from '../../features/send/photoEdit/PhotoEditor';
import { pickPhotosToPdf } from '../../features/send/photos';
import { createSenderApi } from '../../features/send/senderApi';
import { pickPdf, scanToPdf, type SourceResult } from '../../features/send/sources';
import { useSaveCopy, useShare } from '../../features/share/useShare';
import { loadSavedMarks, type AdoptTarget, type SavedMarks } from '../../features/signing/adopt';
import { AdoptSignatureSheet, type AdoptResult } from '../../features/signing/AdoptSignatureSheet';
import { classifySigningError, SIGNING_COPY, type Disclosure } from '../../features/signing/signingApi';
import type { AdoptedMark } from '../../features/signing/signingMachine';
import type { RootStackParamList } from '../../navigation/types';
import { useTheme } from '../../theme';
import { base64Encode } from '../../util/bytes';
import { randomId } from '../../util/ids';
import * as WebBrowser from 'expo-web-browser';

type Stage =
  | { kind: 'docs' }
  | { kind: 'place' }
  | { kind: 'consent'; disclosure: Disclosure }
  | { kind: 'working'; label: string }
  | { kind: 'done'; completed: boolean };

const RUN: Record<'scan' | 'photos' | 'files', () => Promise<SourceResult>> = {
  scan: scanToPdf,
  photos: () => pickPhotosToPdf(),
  files: pickPdf,
};

const SOURCE_LABEL: Record<'scan' | 'photos' | 'files', string> = {
  scan: 'Camera scan',
  photos: 'Photos',
  files: 'Files',
};

export function SelfSignScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const qc = useQueryClient();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const services = useServices();
  const { workspace, guest, kv } = services;
  const online = useOnline();
  const ctx = useSenderContext();
  const profile = useSignProfile();
  const settings = useSignSettings();
  const sharer = useShare();
  const saver = useSaveCopy();
  // M-A13 #9 — chosen photos get a crop / straighten / rotate step before the PDF.
  const photoEditor = usePhotoEditor();

  const [stage, setStage] = useState<Stage>({ kind: 'docs' });
  const [docs, setDocs] = useState<SelfDoc[]>([]);
  const [sources, setSources] = useState<Record<string, string>>({});
  const [fields, setFields] = useState<readonly EditorField[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [adopted, setAdopted] = useState<SelfContext['adopted']>({});
  const [adoptFor, setAdoptFor] = useState<AdoptTarget | null>(null);
  const [saved, setSaved] = useState<SavedMarks | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [pickMode, setPickMode] = useState<'sources' | 'templates' | SenderTemplate>('sources');
  const [tplValues, setTplValues] = useState<Record<string, string>>({});
  const tplKey = useRef<string | null>(null);
  const [running, setRunning] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ key: string; title: string } | null>(null);
  const [consented, setConsented] = useState(false);
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const progress = useRef<SelfProgress>(NO_PROGRESS);
  const session = useRef<GuestSigningSession | null>(null);
  const stored = useRef(new Set<string>());
  const [envelopeId, setEnvelopeId] = useState<string | null>(null);

  const api = useMemo(() => createSenderApi(workspace), [workspace]);
  const deps = useMemo(
    () => ({ api, createSelf: createSelfEnvelope(workspace), openSession: (tok: string) => guest.open(tok) }),
    [api, workspace, guest],
  );

  useEffect(() => {
    loadSavedMarks(workspace).then(setSaved, () => setSaved(null));
  }, [workspace]);

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

  // ── 1. Documents ──
  async function add(key: 'scan' | 'photos' | 'files'): Promise<void> {
    setError(null);
    setRunning(true);
    try {
      let r: SourceResult;
      try {
        r = await (key === 'photos' ? pickPhotosToPdf(new Date(), photoEditor.edit) : RUN[key]());
      } catch {
        setError(SOURCE_UNAVAILABLE);
        return;
      }
      if (r.kind === 'cancelled') return;
      if (r.kind === 'refused') {
        setError(r.message);
        return;
      }
      const base64 = base64Encode(r.bytes);
      const doc: SelfDoc = {
        key: randomId(),
        title: r.title,
        filename: r.filename,
        base64,
        pages: r.pages && r.pages.length > 0 ? r.pages : pagesOf(base64),
        serverId: null,
      };
      setDocs((d) => [...d, doc]);
      setSources((s) => ({ ...s, [doc.key]: SOURCE_LABEL[key] }));
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
      setStage({ kind: 'place' });
    } catch (e) {
      setError(selfSignRefusalCopy(e, SELF_COPY.uploadFailed));
    } finally {
      setRunning(false);
    }
  }

  // Templates as a source: the template's documents and fields, for the caller only.
  const templatesOn = templatesAvailable(ctx.data ?? null) && docs.length === 0 && envelopeId === null;
  const templates = useTemplatesView(picking && templatesOn && pickMode !== 'sources');
  function closePicker(): void {
    setPicking(false);
    setPickMode('sources');
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
        {
          createFromTemplate: createSelfFromTemplate(workspace),
          fetchSource: (envId, docId) =>
            fetchSourcePdf(
              { baseUrl: services.env.apiBaseUrl, fetch: (u, i) => fetch(u, i), session: services.session },
              envId,
              docId,
            ),
        },
        { templateId: tpl.id, values: tplValues, idempotencyKey: tplKey.current },
      );
      progress.current = r.progress;
      setEnvelopeId(r.progress.envelopeId);
      setDocs(r.docs);
      setFields(r.fields);
      setSources(Object.fromEntries(r.docs.map((d) => [d.key, 'Template'])));
      closePicker();
      setStage({ kind: 'place' });
    } catch (e) {
      setError(selfSignRefusalCopy(e, SELF_COPY.uploadFailed));
    } finally {
      setRunning(false);
    }
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

  function onAdopted(r: AdoptResult): void {
    const target = adoptFor ?? 'SIGNATURE';
    setAdopted((a) => ({ ...a, [target]: r.mark as AdoptedMark }));
    setAdoptFor(null);
    if (placeAfterAdopt.current) setPlaceRequest((p) => ({ type: target, id: (p?.id ?? 0) + 1 }));
    placeAfterAdopt.current = false;
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
      return (
        <Button
          variant="secondary"
          title={f.type === 'SIGNATURE' ? 'Change signature' : 'Change initials'}
          onPress={() => setAdoptFor(f.type as AdoptTarget)}
        />
      );
    }
    if (f.type === 'SIGNER_NAME' && (f.nameMode ?? 'SIGNER_PROFILE') === 'SIGNER_PROFILE') {
      return (
        <Text style={{ color: t.color.textSecondary, fontSize: 14 }}>
          Your name on the account is filled in when you finish.
        </Text>
      );
    }
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
        style={[styles.input, { borderColor: t.color.separator, color: t.color.text, backgroundColor: t.color.surface }]}
      />
    );
  };

  async function finish(): Promise<void> {
    const check = canFinish(fields, selfCtx, edits);
    if (!check.ok) {
      toast.show(check.message ?? SELF_COPY.needSignature);
      return;
    }
    if (!online) {
      setError(SELF_COPY.offline);
      return;
    }
    setError(null);
    setStage({ kind: 'working', label: 'Preparing your document' });
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
      setError(selfSignRefusalCopy(e, SELF_COPY.finishFailed));
      setStage({ kind: 'place' });
    }
  }

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
    setStage({ kind: 'working', label: 'Signing' });
    try {
      const r = await acceptFillComplete(s, disclosure, fields, docs, selfCtx, edits, stored.current, (id) =>
        stored.current.add(id),
      );
      s.discard();
      session.current = null;
      void qc.invalidateQueries({ queryKey: signKeys.senderList });
      setStage({ kind: 'done', completed: r.envelopeStatus === 'COMPLETED' });
    } catch (e) {
      const kind = classifySigningError(e);
      setError(kind === 'ended' ? SIGNING_COPY.ended : SELF_COPY.finishFailed);
      setStage({ kind: 'consent', disclosure });
    }
  }

  const close = () => navigation.goBack();
  const textStyle = { color: t.color.text, fontFamily: t.font.family };
  const secondary = { color: t.color.textSecondary, fontFamily: t.font.family };

  // ── Render ──
  if (stage.kind === 'working') {
    return (
      <View style={[styles.center, { backgroundColor: t.color.screen }]} testID="self-working">
        <ActivityIndicator color={t.color.accent} accessibilityLabel={stage.label} />
        <Text style={[secondary, { marginTop: 12 }]}>{stage.label}</Text>
      </View>
    );
  }

  if (stage.kind === 'done') {
    const id = envelopeId;
    return (
      <View style={[styles.end, { backgroundColor: t.color.screen }]} testID="self-done">
        <View style={[styles.mark, { backgroundColor: t.color.success }]}>
          <Svg width={40} height={40} viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
            <Path d="M5 12l5 5 9-10" />
          </Svg>
        </View>
        <Text accessibilityRole="header" style={[styles.endTitle, textStyle]}>
          You signed
        </Text>
        <Text style={[styles.endBody, secondary]}>
          {stage.completed ? SELF_COPY.done : 'Your signature is saved. The signed copy will be ready shortly.'}
        </Text>
        {stage.completed && id ? (
          <>
            {/* M-A13 #7: View signed copy and Save a copy, beside Share PDF and the certificate. */}
            <Button
              testID="self-view-signed"
              title="View signed copy"
              disabled={!online}
              onPress={() => navigation.navigate('DocumentViewer', { envelopeId: id, kind: 'executed' })}
            />
            <Button
              testID="self-save"
              title="Save a copy"
              variant="secondary"
              busy={saver.busy}
              disabled={!online}
              onPress={() => saver.save({ kind: 'sent', envelopeId: id, subject: selfSubject(docs) })}
            />
            <Button
              testID="self-share"
              title="Share PDF"
              variant="secondary"
              busy={sharer.busy}
              disabled={!online}
              onPress={() => sharer.share({ kind: 'sent', envelopeId: id, subject: selfSubject(docs) })}
            />
            <Button
              testID="self-certificate"
              title="View certificate"
              variant="secondary"
              disabled={!online}
              onPress={() => navigation.navigate('DocumentViewer', { envelopeId: id, kind: 'certificate' })}
            />
          </>
        ) : null}
        <Button title="Done" variant="text" onPress={close} />
      </View>
    );
  }

  if (stage.kind === 'consent') {
    const d = stage.disclosure;
    return (
      <ScrollView style={{ flex: 1, backgroundColor: t.color.screen }} contentContainerStyle={styles.consent} testID="self-consent">
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
    const placedCount = fields.length;
    const pages = totalPages(docs);
    return (
      <View style={{ flex: 1, backgroundColor: t.color.screen }} testID="self-place">
        <View style={[styles.placeHead, { borderBottomColor: t.color.separator }]}>
          <Text style={[secondary, { flex: 1, fontSize: 13 }]} numberOfLines={1}>
            {`${pages} ${pages === 1 ? 'page' : 'pages'} · ${placedCount} ${placedCount === 1 ? 'field placed' : 'fields placed'}`}
          </Text>
          <Button testID="self-more" title="…" variant="text" accessibilityLabel="More" onPress={() => setMoreOpen(true)} />
        </View>
        {error ? (
          <View style={{ padding: 12 }}>
            <Banner body={error} />
          </View>
        ) : null}
        <FieldEditor
          documents={editorDocs}
          recipients={recipients}
          initialFields={fields}
          loadAsset={loadAsset}
          onFieldsChange={setFields}
          fillFor={(f) => displayFill(f, selfCtx, edits)}
          onPickTool={onPickTool}
          renderSelectionExtra={renderValue}
          fieldScale={sizeScale(settings.data?.default_field_size)}
          findDocs={findDocs}
          hideRecipients
          placeRequest={placeRequest}
        />
        <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 12), borderTopColor: t.color.separator, backgroundColor: t.color.surface }]}>
          <Button title="Back" variant="text" onPress={() => setStage({ kind: 'docs' })} />
          <Button
            testID="self-finish"
            title="Finish"
            disabled={!online}
            style={{ flex: 1 }}
            onPress={() => void finish()}
          />
        </View>
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
          <Text style={[secondary, { fontSize: 14 }]}>Only you sign this document. Nobody is emailed.</Text>
          <Button title="Close" variant="text" onPress={() => setDetailsOpen(false)} />
        </Sheet>
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

  // ── Documents stage ──
  const menu = menuFor ? docMenu(docs, menuFor) : null;
  return (
    <View style={{ flex: 1, backgroundColor: t.color.screen }} testID="self-docs">
      <ScrollView contentContainerStyle={styles.docs}>
        <Text style={[secondary, { fontSize: 15, lineHeight: 21 }]}>
          Add the document you want to sign. Only you sign it, and nobody is emailed. Signing is always free.
        </Text>
        {!online ? <Banner tone="offline" body={SELF_COPY.offline} /> : null}
        {docs.length > 0 ? (
          <Card>
            {docs.map((d, i) => (
              <View
                key={d.key}
                testID={`self-doc-${i}`}
                style={[styles.docRow, i < docs.length - 1 ? { borderBottomColor: t.color.separator, borderBottomWidth: StyleSheet.hairlineWidth } : null]}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={[textStyle, { fontSize: 16 }]} numberOfLines={2}>
                    {d.title}
                  </Text>
                  <Text style={[secondary, { fontSize: 13 }]}>
                    {[pageCountLabel(d.pages), sources[d.key]].filter(Boolean).join(' · ')}
                  </Text>
                </View>
                <Pressable
                  testID={`self-doc-menu-${i}`}
                  onPress={() => setMenuFor(d.key)}
                  accessibilityRole="button"
                  accessibilityLabel={`More for ${d.title}`}
                  hitSlop={8}
                  style={{ minWidth: t.size.minTouch, minHeight: t.size.minTouch, alignItems: 'center', justifyContent: 'center' }}
                >
                  <Text style={[textStyle, { fontSize: 20 }]}>…</Text>
                </Pressable>
              </View>
            ))}
          </Card>
        ) : null}
        <Button
          testID="self-add"
          title={docs.length ? 'Add another document' : 'Add a document'}
          variant="secondary"
          onPress={() => setPicking(true)}
        />
        {error ? <Text accessibilityRole="alert" style={{ color: t.color.destructive, fontSize: 14 }}>{error}</Text> : null}
      </ScrollView>
      <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 12), borderTopColor: t.color.separator, backgroundColor: t.color.surface }]}>
        <Button title="Cancel" variant="text" onPress={close} />
        <Button
          testID="self-next"
          title="Next"
          style={{ flex: 1 }}
          busy={running}
          disabled={docs.length === 0 || running || !online}
          onPress={() => void next()}
        />
      </View>
      <Sheet
        visible={picking}
        onClose={closePicker}
        title={pickMode === 'sources' ? 'Add a document' : pickMode === 'templates' ? 'Templates' : pickMode.name}
      >
        {pickMode === 'sources' ? (
          <View style={styles.tiles}>
            {addSourceTiles(templatesOn).map((tile) => (
              <Button
                key={tile.key}
                testID={`self-source-${tile.key}`}
                title={tile.label}
                variant="secondary"
                disabled={running}
                accessibilityHint={tile.hint}
                onPress={() =>
                  tile.key === 'templates' ? setPickMode('templates') : void add(tile.key as 'scan' | 'photos' | 'files')
                }
              />
            ))}
          </View>
        ) : pickMode === 'templates' ? (
          templates.view.kind === 'list' ? (
            <TemplateRows rows={templates.view.rows} onUse={(tpl) => setPickMode(tpl)} disabled={running} />
          ) : templates.view.kind === 'loading' ? (
            <ActivityIndicator color={t.color.accent} accessibilityLabel="Loading templates" />
          ) : (
            <EmptyState
              title="No templates"
              body={'message' in templates.view ? templates.view.message : 'Templates couldn’t be loaded.'}
            />
          )
        ) : (
          <View style={styles.tiles} testID="self-template-form">
            {pickMode.senderVariables.map((v) => (
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
              disabled={running || !online || pickMode.senderVariables.some((v) => !(tplValues[v.key] ?? '').trim())}
              onPress={() => void startTemplate(pickMode)}
            />
          </View>
        )}
        {error && picking ? (
          <Text accessibilityRole="alert" style={{ color: t.color.destructive, fontSize: 14 }}>
            {error}
          </Text>
        ) : null}
        {running && pickMode === 'sources' ? (
          <ActivityIndicator color={t.color.accent} accessibilityLabel="Adding the document" />
        ) : null}
        <Button
          title={pickMode === 'sources' ? 'Close' : 'Back'}
          variant="text"
          onPress={() => (pickMode === 'sources' ? closePicker() : setPickMode(pickMode === 'templates' ? 'sources' : 'templates'))}
        />
        {photoEditor.element}
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
        <Button
          testID="self-doc-remove"
          title="Remove"
          variant="destructive"
          onPress={() => menuFor && void remove(menuFor)}
        />
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
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  end: { flex: 1, padding: 24, gap: 14, justifyContent: 'center' },
  endTitle: { fontSize: 24, fontWeight: '700', textAlign: 'center' },
  endBody: { fontSize: 16, lineHeight: 23, textAlign: 'center' },
  mark: { width: 76, height: 76, borderRadius: 38, alignSelf: 'center', alignItems: 'center', justifyContent: 'center' },
  consent: { padding: 16, gap: 16 },
  docs: { padding: 16, gap: 14 },
  docRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, paddingHorizontal: 12 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
  placeHead: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  tiles: { gap: 10 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, minHeight: 44, fontSize: 16 },
});
