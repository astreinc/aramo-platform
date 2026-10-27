// The signer experience (handoff §4.4; directive §6, §9, §10; M-A2 §2): consent →
// fields → signed, plus decline, adopt, text entry and the biometric confirmation.
// Runs ONLY on a GuestSigningSession (capability-token transport). Used by the emailed
// link flow (GuestSigningScreen) and by inbox signing (SigningScreen).
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  findNodeHandle,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
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
import { useTheme } from '../../theme';
import { dateTime } from '../inbox/agreementsModel';
import { useOnline } from '../inbox/queries';
import { CheckRow, ProgressBar, ReasonSheet } from '../inbox/ui';
import { loadSavedMarks, saveDefaultMark, type AdoptTarget, type SavedMarks } from './adopt';
import { AdoptSignatureSheet, type AdoptResult } from './AdoptSignatureSheet';
import { boxOnPage, PdfPages, type PageLayout } from './PdfPages';
import {
  acceptAndLoad,
  classifySigningError,
  declineSigning,
  DECLINE_REASON_MIN,
  loadSource,
  openSigning,
  SIGNING_COPY,
  submitSigning,
  waitingForCopy,
  type Disclosure,
  type SignerView,
} from './signingApi';
import {
  adopt,
  advance,
  attemptFinish,
  canFinish,
  displayOf,
  emptyCaption,
  fieldAnnouncement,
  initialState,
  isFilled,
  primaryAction,
  requiredDone,
  requiredFields,
  setText,
  tapField,
  type SigningField,
  type SigningState,
} from './signingMachine';
import { useReducedMotion } from './useReducedMotion';
import { ZoomablePages } from './ZoomablePages';

type Phase =
  | { kind: 'loading' }
  | { kind: 'consent'; disclosure: Disclosure }
  | { kind: 'fields' }
  | { kind: 'signed'; completed: boolean; at: string }
  | { kind: 'declined' }
  | { kind: 'ended'; message: string }
  | { kind: 'waiting'; message: string }
  | { kind: 'error'; message: string };

export interface SigningFlowProps {
  readonly session: GuestSigningSession | null;
  /** From the inbox item or account, when known (never from other recipients). */
  readonly senderName?: string | null;
  readonly subject?: string | null;
  /** The signer's name for SIGNER_NAME fields and the typed signature default. */
  readonly signerName: string;
  /** Signed in: saved defaults can be offered and saved. */
  readonly signedIn: boolean;
  /** Emailed-link flow while signed in: add this envelope to the user's inbox (claim). */
  readonly onClaim?: () => Promise<string | null>;
  readonly onViewCertificate?: () => void;
  readonly onDone: () => void;
  /** Lets the screen put Finish in the navigation bar (handoff §4.4). */
  readonly onHeaderFinish?: (
    h: { visible: boolean; enabled: boolean; onPress: () => void } | null,
  ) => void;
}

type Action = { type: 'set'; state: SigningState };

function reducer(_s: SigningState, a: Action): SigningState {
  return a.state;
}

const EMPTY: SigningState = { fields: [], values: {}, currentId: null, adopted: {} };

export function SigningFlow(props: SigningFlowProps) {
  const {
    session,
    senderName,
    subject,
    signerName,
    signedIn,
    onClaim,
    onViewCertificate,
    onDone,
    onHeaderFinish,
  } = props;
  const t = useTheme();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const { kv, workspace } = useServices();
  const online = useOnline();
  const reduceMotion = useReducedMotion();
  const { width } = useWindowDimensions();
  const pageWidth = Math.max(200, width - 24);

  const [phase, setPhase] = useState<Phase>(
    session ? { kind: 'loading' } : { kind: 'ended', message: SIGNING_COPY.ended },
  );
  const [consented, setConsented] = useState(false);
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const [view, setView] = useState<SignerView | null>(null);
  const [sources, setSources] = useState<Record<string, string | null>>({});
  const [state, dispatch] = useReducer(reducer, EMPTY);
  // The latest state for event handlers; written only by commit(), never during render.
  const stateRef = useRef(EMPTY);
  const commit = useCallback((s: SigningState) => {
    stateRef.current = s;
    dispatch({ type: 'set', state: s });
  }, []);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [adoptFor, setAdoptFor] = useState<{ fieldId: string | null; target: AdoptTarget } | null>(
    null,
  );
  const [textFor, setTextFor] = useState<{ fieldId: string; initial: string } | null>(null);
  const [textDraft, setTextDraft] = useState('');
  const [declineOpen, setDeclineOpen] = useState(false);
  const [declineError, setDeclineError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedMarks | null>(null);
  const [claimState, setClaimState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [claimMessage, setClaimMessage] = useState<string | null>(null);

  const scrollRef = useRef<ScrollView>(null);
  // Android pinch zoom factor (iOS zooms natively): scroll targets scale with it.
  const zoomRef = useRef(1);
  const docY = useRef<Record<string, number>>({});
  const pageY = useRef<Record<string, Record<number, number>>>({});
  const layouts = useRef<Record<string, PageLayout>>({});
  const fieldRefs = useRef<Record<string, View | null>>({});

  const fail = useCallback((e: unknown) => {
    const kind = classifySigningError(e);
    if (kind === 'ended') setPhase({ kind: 'ended', message: SIGNING_COPY.ended });
    else if (kind === 'not_your_turn') setPhase({ kind: 'waiting', message: waitingForCopy(e) });
    else if (kind === 'executed') setPhase({ kind: 'ended', message: SIGNING_COPY.executed });
    else
      setPhase({
        kind: 'error',
        message:
          kind === 'network' ? SIGNING_COPY.submitFailed : 'Something went wrong. Try again.',
      });
  }, []);

  // Open: exchange + current disclosure (consent is shown every time, never pre-checked).
  useEffect(() => {
    if (!session) return undefined;
    let live = true;
    openSigning(session).then(
      (d) => {
        if (live) setPhase({ kind: 'consent', disclosure: d });
      },
      (e: unknown) => {
        if (live) fail(e);
      },
    );
    return () => {
      live = false;
    };
  }, [session, fail]);

  function open(): void {
    if (!session) return;
    setPhase({ kind: 'loading' });
    setConsented(false);
    openSigning(session).then((d) => setPhase({ kind: 'consent', disclosure: d }), fail);
  }

  useEffect(() => {
    if (!signedIn) return;
    loadSavedMarks(workspace).then(setSaved, () => setSaved(null));
  }, [signedIn, workspace]);

  async function accept(d: Disclosure): Promise<void> {
    if (!session) return;
    setBusy(true);
    try {
      const v = await acceptAndLoad(session, d);
      setView(v);
      commit(initialState(v.fields, v.documents));
      setPhase({ kind: 'fields' });
      for (const doc of v.documents) {
        loadSource(session, doc.document_id).then(
          (b64) => setSources((m) => ({ ...m, [doc.document_id]: b64 })),
          (e: unknown) => {
            if (classifySigningError(e) === 'ended') fail(e);
            else setSources((m) => ({ ...m, [doc.document_id]: null }));
          },
        );
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  const focusField = useCallback(
    (id: string | null) => {
      if (!id) return;
      const f = stateRef.current.fields.find((x) => x.field_id === id);
      const layout = f ? layouts.current[`${f.document_id}:${f.page_number}`] : undefined;
      if (f && layout) {
        const top =
          (docY.current[f.document_id] ?? 0) +
          (pageY.current[f.document_id]?.[f.page_number] ?? 0) +
          boxOnPage(f, layout).top;
        scrollRef.current?.scrollTo({
          y: Math.max(0, top * zoomRef.current - 150),
          animated: !reduceMotion,
        });
      }
      const node = fieldRefs.current[id] ? findNodeHandle(fieldRefs.current[id]) : null;
      if (node)
        setTimeout(() => AccessibilityInfo.setAccessibilityFocus(node), reduceMotion ? 0 : 350);
    },
    [reduceMotion],
  );

  function onTap(f: SigningField): void {
    const { state: next, effect } = tapField(stateRef.current, f.field_id, { signerName });
    commit(next);
    if (effect.kind === 'adopt') setAdoptFor({ fieldId: effect.fieldId, target: effect.target });
    else if (effect.kind === 'text') {
      setTextDraft(effect.initial);
      setTextFor({ fieldId: effect.fieldId, initial: effect.initial });
    } else if (next.currentId && next.currentId !== f.field_id) {
      focusField(next.currentId);
    }
  }

  async function onAdopted(r: AdoptResult): Promise<void> {
    const target = adoptFor?.target ?? 'SIGNATURE';
    const next = adopt(stateRef.current, target, r.mark, adoptFor?.fieldId ?? null);
    commit(next);
    setAdoptFor(null);
    if (r.saveDefault && signedIn) {
      saveDefaultMark(workspace, target, r.mark, r.typedName).then(
        () =>
          toast.show(target === 'SIGNATURE' ? 'Default signature saved' : 'Default initials saved'),
        () => undefined,
      );
    }
    focusField(next.currentId);
  }

  function onNext(): void {
    const next = advance(stateRef.current);
    commit(next);
    focusField(next.currentId);
  }

  const finish = useCallback(async () => {
    if (!session) return;
    const check = attemptFinish(stateRef.current);
    if (check.blocked) {
      commit(check.state);
      toast.show(SIGNING_COPY.incomplete);
      focusField(check.state.currentId);
      return;
    }
    // No offline signing (directive §9): values stay on the device until connected.
    if (!online) {
      setSubmitError(SIGNING_COPY.offline);
      return;
    }
    const pref = await biometricConfirmPref.get(kv).catch(() => false);
    if (pref) {
      const cap = await biometricCapability().catch(() => null);
      if (cap?.available) {
        const ok = await confirmLocally('Confirm it’s you to finish signing').catch(() => false);
        if (!ok) return; // stay on the page
      }
    }
    setBusy(true);
    setSubmitError(null);
    try {
      const r = await submitSigning(session, stateRef.current, commit);
      setPhase({
        kind: 'signed',
        completed: r.envelopeStatus === 'COMPLETED',
        at: new Date().toISOString(),
      });
    } catch (e) {
      const kind = classifySigningError(e);
      if (kind === 'network' || kind === 'error') setSubmitError(SIGNING_COPY.submitFailed);
      else if (kind === 'incomplete') {
        setSubmitError(SIGNING_COPY.incomplete);
      } else fail(e);
    } finally {
      setBusy(false);
    }
  }, [session, online, kv, toast, focusField, fail, commit]);

  const fieldsPhase = phase.kind === 'fields';
  const finishEnabled = fieldsPhase && canFinish(state) && !busy;
  useEffect(() => {
    onHeaderFinish?.(
      fieldsPhase ? { visible: true, enabled: finishEnabled, onPress: () => void finish() } : null,
    );
  }, [fieldsPhase, finishEnabled, finish, onHeaderFinish]);

  async function decline(reason: string): Promise<void> {
    if (!session) return;
    if (!online) {
      setDeclineError('You’re offline. Connect to decline.');
      return;
    }
    setBusy(true);
    setDeclineError(null);
    try {
      await declineSigning(session, reason);
      setDeclineOpen(false);
      toast.show('You declined to sign');
      setPhase({ kind: 'declined' });
    } catch (e) {
      const kind = classifySigningError(e);
      if (kind === 'network' || kind === 'error')
        setDeclineError('Couldn’t decline. Check your connection and try again.');
      else {
        setDeclineOpen(false);
        fail(e);
      }
    } finally {
      setBusy(false);
    }
  }

  async function claim(): Promise<void> {
    if (!onClaim) return;
    setClaimState('busy');
    const msg = await onClaim();
    setClaimMessage(msg);
    setClaimState(msg === null ? 'done' : 'idle');
  }

  const from = senderName?.trim() ? senderName.trim() : 'The sender';

  // ── End states ──
  if (phase.kind === 'loading') {
    return (
      <View style={[styles.center, { backgroundColor: t.color.screen }]}>
        <ActivityIndicator color={t.color.accent} accessibilityLabel="Loading" />
      </View>
    );
  }
  if (
    phase.kind === 'ended' ||
    phase.kind === 'waiting' ||
    phase.kind === 'error' ||
    phase.kind === 'declined'
  ) {
    const title =
      phase.kind === 'waiting'
        ? phase.message
        : phase.kind === 'declined'
          ? 'You declined to sign'
          : phase.kind === 'ended'
            ? 'This link can’t be used'
            : 'Couldn’t open this envelope';
    const body =
      phase.kind === 'waiting'
        ? 'It’s not your turn to sign yet. You’ll get an email when it is.'
        : phase.kind === 'declined'
          ? `${from} is told you declined, and the envelope stops for everyone.`
          : phase.message;
    return (
      <View
        style={[styles.end, { backgroundColor: t.color.screen }]}
        testID={`signing-${phase.kind}`}
      >
        <Text
          accessibilityRole="header"
          style={[styles.endTitle, { color: t.color.text, fontFamily: t.font.family }]}
        >
          {title}
        </Text>
        <Text style={[styles.endBody, { color: t.color.textSecondary, fontFamily: t.font.family }]}>
          {body}
        </Text>
        {phase.kind === 'error' ? (
          <Button title="Try again" onPress={open} disabled={!online} />
        ) : null}
        <Button title="Done" variant="secondary" onPress={onDone} />
      </View>
    );
  }
  if (phase.kind === 'signed') {
    return (
      <View style={[styles.end, { backgroundColor: t.color.screen }]} testID="signing-signed">
        <View style={[styles.signedMark, { backgroundColor: t.color.success }]}>
          <Svg
            width={40}
            height={40}
            viewBox="0 0 24 24"
            fill="none"
            stroke="#FFFFFF"
            strokeWidth={2.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <Path d="M5 12l5 5 9-10" />
          </Svg>
        </View>
        <Text
          accessibilityRole="header"
          style={[styles.endTitle, { color: t.color.text, fontFamily: t.font.family }]}
        >
          You signed
        </Text>
        <Text style={[styles.endBody, { color: t.color.textSecondary, fontFamily: t.font.family }]}>
          {phase.completed
            ? 'Everyone has signed. The completed copy and certificate are ready.'
            : 'Waiting on the other signers. We’ll let you know when they sign.'}
        </Text>
        <Text style={{ color: t.color.textTertiary, fontSize: 13 }}>{dateTime(phase.at)}</Text>
        {phase.completed && onViewCertificate ? (
          <Button title="View certificate" variant="secondary" onPress={onViewCertificate} />
        ) : null}
        {onClaim && claimState !== 'done' ? (
          <Button
            title="Save to my inbox"
            variant="secondary"
            busy={claimState === 'busy'}
            disabled={!online}
            onPress={() => void claim()}
          />
        ) : null}
        {claimMessage ? (
          <Text style={{ color: t.color.textSecondary, textAlign: 'center' }}>{claimMessage}</Text>
        ) : null}
        <Button title="Done" onPress={onDone} />
      </View>
    );
  }

  // ── Consent ──
  if (phase.kind === 'consent') {
    const d = phase.disclosure;
    return (
      <View style={{ flex: 1, backgroundColor: t.color.screen }}>
        <ScrollView contentContainerStyle={styles.consent}>
          <Text style={{ color: t.color.textSecondary, fontSize: 15, fontFamily: t.font.family }}>
            {senderName ? `${from} sent you documents to sign` : 'You’ve been asked to sign'}
          </Text>
          {subject ? (
            <Text
              accessibilityRole="header"
              style={{ color: t.color.text, fontFamily: t.font.family, ...t.type.detailTitle }}
            >
              {subject}
            </Text>
          ) : null}
          {d.message ? (
            <Card style={styles.quote}>
              {/* Sender-supplied plain text (M-A3 §3): rendered as text, never markup. */}
              <Text
                style={{ color: t.color.text, fontSize: 15, lineHeight: 21, fontStyle: 'italic' }}
              >{`“${d.message}”`}</Text>
            </Card>
          ) : null}
          {onClaim && claimState !== 'done' ? (
            <Card style={styles.quote}>
              <Text style={{ color: t.color.text, fontSize: 15 }}>
                Keep this envelope in your Aramo Sign inbox.
              </Text>
              <Button
                title="Save to my inbox"
                variant="secondary"
                busy={claimState === 'busy'}
                disabled={!online}
                onPress={() => void claim()}
              />
              {claimMessage ? (
                <Text style={{ color: t.color.textSecondary }}>{claimMessage}</Text>
              ) : null}
            </Card>
          ) : null}
          <CheckRow
            testID="consent-check"
            checked={consented}
            onToggle={() => setConsented((c) => !c)}
            accessibilityLabel="I agree to use electronic records and signatures"
          >
            <Text
              style={{
                color: t.color.text,
                fontSize: 15,
                lineHeight: 21,
                fontFamily: t.font.family,
              }}
            >
              I agree to use electronic records and signatures.{' '}
              <Text
                accessibilityRole="link"
                onPress={() => setDisclosureOpen(true)}
                style={{ color: t.color.accent, fontWeight: '600' }}
              >
                Read the disclosure
              </Text>
            </Text>
          </CheckRow>
          {!online ? <Banner tone="offline" body="You’re offline. Connect to continue." /> : null}
          <Button
            testID="consent-continue"
            title="Continue"
            disabled={!consented || !online}
            busy={busy}
            onPress={() => void accept(d)}
          />
          <Button
            title="Decline to sign"
            variant="text"
            onPress={() => setDeclineOpen(true)}
            accessibilityLabel="Decline to sign"
            style={{ alignSelf: 'center' }}
          />
        </ScrollView>
        <Sheet
          visible={disclosureOpen}
          onClose={() => setDisclosureOpen(false)}
          title="Electronic records and signatures"
        >
          <Text
            style={{ color: t.color.textSecondary, fontSize: 13 }}
          >{`Version ${d.disclosure_version}`}</Text>
          <Text style={{ color: t.color.text, fontSize: 15, lineHeight: 22 }}>{d.text}</Text>
          <Button title="Close" variant="secondary" onPress={() => setDisclosureOpen(false)} />
        </Sheet>
        <ReasonSheet
          visible={declineOpen}
          title="Decline to sign?"
          body={`${from} is told you declined, and the envelope stops for everyone.`}
          confirmLabel="Decline"
          placeholder="Reason (required)"
          minLength={DECLINE_REASON_MIN}
          busy={busy}
          error={declineError}
          onConfirm={(r) => void decline(r)}
          onClose={() => setDeclineOpen(false)}
        />
      </View>
    );
  }

  // ── Fields ──
  const req = requiredFields(state).length;
  const done = requiredDone(state);
  const action = primaryAction(state);
  const docs = [...(view?.documents ?? [])].sort((a, b) => a.ordinal - b.ordinal);

  function renderOverlay(documentId: string, index: number, layout: PageLayout) {
    layouts.current[`${documentId}:${index}`] = layout;
    return state.fields
      .filter((f) => f.document_id === documentId && f.page_number === index)
      .map((f) => {
        const box = boxOnPage(f, layout);
        const v = state.values[f.field_id];
        const shown = displayOf(f, v);
        const current = state.currentId === f.field_id;
        const filled = isFilled(state, f.field_id);
        const slopV = Math.max(0, (t.size.minTouch - box.height) / 2);
        const slopH = Math.max(0, (t.size.minTouch - box.width) / 2);
        return (
          <Pressable
            key={f.field_id}
            ref={(r) => {
              fieldRefs.current[f.field_id] = r;
            }}
            testID={`field-${f.field_id}`}
            onPress={() => onTap(f)}
            accessibilityRole="button"
            accessibilityLabel={fieldAnnouncement(state, f, signerName)}
            accessibilityHint={filled ? 'Double tap to clear' : 'Double tap to fill'}
            hitSlop={{ top: slopV, bottom: slopV, left: slopH, right: slopH }}
            style={[
              styles.field,
              { left: box.left, top: box.top, width: box.width, height: box.height },
              filled
                ? {
                    borderWidth: 1,
                    borderColor: 'rgba(2,42,192,0.30)',
                    backgroundColor: 'rgba(2,42,192,0.04)',
                  }
                : {
                    borderWidth: 1.5,
                    borderStyle: 'dashed',
                    borderColor: t.color.accent,
                    backgroundColor: 'rgba(2,42,192,0.09)',
                  },
              current ? styles.current : null,
            ]}
          >
            {shown?.kind === 'image' ? (
              <Image
                source={{ uri: shown.text }}
                style={styles.fieldImage}
                resizeMode="contain"
                accessibilityIgnoresInvertColors
              />
            ) : shown ? (
              <Text
                numberOfLines={1}
                adjustsFontSizeToFit
                style={{ color: '#0B1F6B', fontSize: Math.max(9, Math.min(16, box.height * 0.6)) }}
              >
                {shown.text}
              </Text>
            ) : (
              <Text
                numberOfLines={1}
                adjustsFontSizeToFit
                style={{
                  color: t.color.accent,
                  fontSize: Math.max(8, Math.min(13, box.height * 0.5)),
                  fontWeight: '600',
                }}
              >
                {emptyCaption(f)}
              </Text>
            )}
          </Pressable>
        );
      });
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.color.documentBackdrop }}>
      {!online ? (
        <View style={styles.offline}>
          <Banner tone="offline" body={SIGNING_COPY.offline} />
        </View>
      ) : null}
      <ZoomablePages
        ref={scrollRef}
        contentContainerStyle={styles.pages}
        onZoomChange={(z) => (zoomRef.current = z)}
      >
        {docs.map((doc) => {
          const src = sources[doc.document_id];
          return (
            <View
              key={doc.document_id}
              onLayout={(e) => (docY.current[doc.document_id] = e.nativeEvent.layout.y)}
            >
              {src === undefined ? (
                <View
                  style={[styles.loadingPage, { width: pageWidth, backgroundColor: t.color.white }]}
                >
                  <ActivityIndicator
                    color={t.color.accent}
                    accessibilityLabel={`Loading ${doc.title}`}
                  />
                </View>
              ) : src === null ? (
                <View
                  style={[styles.loadingPage, { width: pageWidth, backgroundColor: t.color.white }]}
                >
                  <Text style={{ color: t.color.textSecondary, textAlign: 'center', padding: 16 }}>
                    {`${doc.title} couldn’t be loaded. Check your connection.`}
                  </Text>
                </View>
              ) : (
                <PdfPages
                  source={{ kind: 'base64', base64: src }}
                  width={pageWidth}
                  title={doc.title}
                  onPageLayout={(i, y) => {
                    pageY.current[doc.document_id] = {
                      ...(pageY.current[doc.document_id] ?? {}),
                      [i]: y,
                    };
                  }}
                  renderOverlay={(i, layout) => renderOverlay(doc.document_id, i, layout)}
                />
              )}
            </View>
          );
        })}
      </ZoomablePages>
      <View
        style={[
          styles.bar,
          {
            backgroundColor: t.color.surface,
            paddingBottom: Math.max(insets.bottom, 12),
            borderTopColor: t.color.separator,
            borderTopWidth: t.size.separatorWidth,
          },
        ]}
      >
        {submitError ? (
          <Text accessibilityRole="alert" style={{ color: t.color.destructive, fontSize: 14 }}>
            {submitError}
          </Text>
        ) : null}
        <View style={styles.barRow}>
          <View style={{ flex: 1, gap: 6 }}>
            <Text
              style={{ color: t.color.textSecondary, fontSize: 13 }}
              accessibilityLiveRegion="polite"
            >
              {`${done} of ${req} required fields`}
            </Text>
            <ProgressBar fraction={req === 0 ? 1 : done / req} color={t.color.accent} height={4} />
          </View>
          <Button
            testID="signing-primary"
            title={action === 'start' ? 'Start' : action === 'next' ? 'Next field' : 'Finish'}
            busy={busy}
            onPress={() => (action === 'finish' ? void finish() : onNext())}
            style={{ minWidth: 132 }}
          />
        </View>
        <Button title="Decline to sign" variant="text" onPress={() => setDeclineOpen(true)} />
      </View>
      <AdoptSignatureSheet
        visible={adoptFor !== null}
        target={adoptFor?.target ?? 'SIGNATURE'}
        mode="sign"
        defaultName={signerName}
        canSaveDefault={signedIn}
        saved={adoptFor?.target === 'INITIALS' ? saved?.initials : saved?.signature}
        onAdopt={onAdopted}
        onClose={() => setAdoptFor(null)}
      />
      <Sheet
        visible={textFor !== null}
        onClose={() => setTextFor(null)}
        title={
          state.fields.find((f) => f.field_id === textFor?.fieldId)?.field_type === 'SIGNER_NAME'
            ? 'Enter your name'
            : 'Enter text'
        }
      >
        <TextInput
          testID="text-field-input"
          value={textDraft}
          onChangeText={setTextDraft}
          accessibilityLabel="Text"
          autoFocus
          maxLength={500}
          style={[
            styles.textInput,
            {
              borderColor: t.color.separator,
              color: t.color.text,
              backgroundColor: t.color.surface,
            },
          ]}
        />
        <Button
          testID="text-field-save"
          title="Save"
          onPress={() => {
            if (textFor) {
              const next = setText(stateRef.current, textFor.fieldId, textDraft);
              commit(next);
              setTextFor(null);
              if (next.currentId && next.currentId !== textFor.fieldId) focusField(next.currentId);
            }
          }}
        />
      </Sheet>
      <ReasonSheet
        visible={declineOpen}
        title="Decline to sign?"
        body={`${from} is told you declined, and the envelope stops for everyone.`}
        confirmLabel="Decline"
        placeholder="Reason (required)"
        minLength={DECLINE_REASON_MIN}
        busy={busy}
        error={declineError}
        onConfirm={(r) => void decline(r)}
        onClose={() => setDeclineOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  end: { flex: 1, padding: 24, gap: 14, justifyContent: 'center' },
  endTitle: { fontSize: 24, fontWeight: '700', textAlign: 'center' },
  endBody: { fontSize: 16, lineHeight: 23, textAlign: 'center' },
  signedMark: {
    width: 76,
    height: 76,
    borderRadius: 38,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
  },
  consent: { padding: 16, gap: 16 },
  quote: { padding: 14, gap: 10 },
  pages: { paddingVertical: 12, gap: 12, alignItems: 'center' },
  loadingPage: { height: 320, alignItems: 'center', justifyContent: 'center', alignSelf: 'center' },
  field: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 3,
    overflow: 'visible',
  },
  current: {
    shadowColor: '#022AC0',
    shadowOpacity: 0.35,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 0 },
    elevation: 3,
    borderWidth: 3,
    borderColor: 'rgba(2,42,192,0.35)',
  },
  fieldImage: { width: '100%', height: '100%' },
  bar: { paddingHorizontal: 16, paddingTop: 10, gap: 6 },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  offline: { padding: 12 },
  textInput: { borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 17, minHeight: 48 },
});
