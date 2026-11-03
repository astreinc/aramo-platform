// Aramo Sign Personal (Free) — native signup (M-A11 §1). Fully native, no browser and no
// web view: details → email code → [phone code, only when the server says `next: phone`]
// → terms (the exact effective Personal documents, rendered from server text, one
// unticked box) → done (the existing Google sign-in). Every decision (eligibility, risk,
// next step, documents) is the server's; this flow only renders it. Refusals show native
// copy. An address that already has an account is answered exactly like a new one by the
// server (a signup id that never verifies), and an explicit refusal shows the same review
// screen as the web, so decoy answers stay indistinguishable here too. Nothing in the flow
// opens a browser (PO: "100% native"): the Privacy Notice at collection is the effective
// document read through GET …/terms/{key}/{version} and shown in-app, like the terms step.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { isApiError, type ApiError } from '../../api/errors';
import { refusalMessage } from '../../api/refusalMessages';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { ARAMO_SIGN_IDENTITY } from '../../config/identity';
import { useTheme } from '../../theme';
import { utf8Encode } from '../../util/bytes';
import { CheckRow } from '../inbox/ui';
import { TextField } from '../send/ui';
import { platformCrypto, type CryptoPort } from '../../auth/pkce';
import { toHex, type IntegritySession } from './integrity';
import type {
  AcceptEntry,
  NativeStartBody,
  SignupApi,
  TermsListDocument,
  TermsText,
} from './signupApi';
import {
  codeFailureMessage,
  COUNTRIES,
  documentLabel,
  HELD_COPY,
  isGmail,
  maskPhone,
  RESEND_SECONDS,
  SIGNUP_COPY,
  startFailure,
  startFailureMessage,
  validateDetails,
  fieldMessage,
  type Country,
  type FieldKey,
  type Held,
  type NextStep,
  type Residence,
} from './signupModel';

export interface SignupDeps {
  readonly api: SignupApi;
  /** null: no Play Integrity in this build (no cloud project number, or not Android). */
  readonly integrity: IntegritySession | null;
  readonly signInWithGoogle: () => Promise<void>;
  readonly now?: () => number;
  readonly crypto?: Pick<CryptoPort, 'sha256'>;
}

type Step =
  | { k: 'details' }
  | { k: 'email'; id: string }
  | { k: 'phone'; id: string }
  | { k: 'terms'; id: string; hint: Held; notice?: string }
  | { k: 'review' }
  | { k: 'notOpen' }
  | { k: 'done'; held: Held };

const asError = (e: unknown): ApiError | null => (isApiError(e) ? e : null);

export function SignupFlow(deps: SignupDeps) {
  const [step, setStep] = useState<Step>({ k: 'details' });
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState<string | null>(null);
  const restart = () => setStep({ k: 'details' });

  switch (step.k) {
    case 'details':
      return (
        <Page testID="signup-details">
          <DetailsStep
            deps={deps}
            onStarted={(id, addr, e164) => {
              setEmail(addr);
              setPhone(e164);
              setStep({ k: 'email', id });
            }}
            onRefused={(addr) => {
              setEmail(addr);
              setStep({ k: 'review' });
            }}
            onNotOpen={() => setStep({ k: 'notOpen' })}
          />
        </Page>
      );
    case 'email':
      return (
        <Page testID="signup-email-code">
          <CodeStep
            key={`email-${step.id}`}
            title="Check your email"
            sub={`We sent a 6-digit code to ${email}. It works for 10 minutes.`}
            submitLabel="Verify email"
            verify={(code) => deps.api.verifyEmail(step.id, code)}
            resend={() => deps.api.resendEmail(step.id).then(() => true)}
            onNext={(next: NextStep) =>
              setStep(
                next === 'phone'
                  ? { k: 'phone', id: step.id }
                  : { k: 'terms', id: step.id, hint: next === 'review' ? 'review' : null },
              )
            }
            onRestart={restart}
          />
        </Page>
      );
    case 'phone':
      return (
        <Page testID="signup-phone">
          <PhoneStep
            id={step.id}
            api={deps.api}
            masked={maskPhone(phone)}
            onNext={(next) =>
              setStep({ k: 'terms', id: step.id, hint: next === 'review' ? 'review' : null })
            }
            onUnavailable={() =>
              // Personal v1.1 §6.3: the account is still created; sending waits for phone assurance.
              setStep({
                k: 'terms',
                id: step.id,
                hint: 'phone_verification_required',
                notice: SIGNUP_COPY.phoneUnavailable,
              })
            }
            onRestart={restart}
          />
        </Page>
      );
    case 'terms': {
      const hint = step.hint;
      return (
        <Page testID="signup-terms">
          <TermsStep
            id={step.id}
            api={deps.api}
            crypto={deps.crypto ?? platformCrypto}
            {...(step.notice !== undefined ? { notice: step.notice } : {})}
            onDone={(held) => setStep({ k: 'done', held: held === undefined ? hint : held })}
            onRefused={() => setStep({ k: 'review' })}
            onNotOpen={() => setStep({ k: 'notOpen' })}
            onRestart={restart}
          />
        </Page>
      );
    }
    case 'review':
      return (
        <Page testID="signup-review">
          <Title>{SIGNUP_COPY.reviewTitle}</Title>
          <Body>{SIGNUP_COPY.reviewBody(email)}</Body>
          <Body testID="signup-review-support">
            {`Questions? Contact Aramo support at ${ARAMO_SIGN_IDENTITY.supportEmail}.`}
          </Body>
        </Page>
      );
    case 'notOpen':
      return (
        <Page testID="signup-not-open">
          <Title>{SIGNUP_COPY.notOpen}</Title>
        </Page>
      );
    case 'done':
      return (
        <Page testID="signup-done">
          <DoneStep email={email} held={step.held} signIn={deps.signInWithGoogle} />
        </Page>
      );
  }
}

// ── Layout ─────────────────────────────────────────────────────────────────

function Page({ children, testID }: { readonly children: ReactNode; readonly testID: string }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      testID={testID}
      keyboardShouldPersistTaps="handled"
      style={{ flex: 1, backgroundColor: t.color.screen }}
      contentContainerStyle={[styles.page, { paddingBottom: insets.bottom + 24 }]}
    >
      {children}
    </ScrollView>
  );
}

function Title({ children }: { readonly children: string }) {
  const t = useTheme();
  return (
    <Text
      accessibilityRole="header"
      style={{ color: t.color.text, fontSize: 22, fontWeight: '700', fontFamily: t.font.family }}
    >
      {children}
    </Text>
  );
}

function Body({ children, testID }: { readonly children: ReactNode; readonly testID?: string }) {
  const t = useTheme();
  return (
    <Text
      testID={testID}
      style={{
        color: t.color.textSecondary,
        fontSize: 15,
        lineHeight: 21,
        fontFamily: t.font.family,
      }}
    >
      {children}
    </Text>
  );
}

function ErrorText({ children, testID }: { readonly children: string; readonly testID?: string }) {
  const t = useTheme();
  return (
    <Text
      testID={testID}
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
      style={{ color: t.color.destructive, fontSize: 15, lineHeight: 21 }}
    >
      {children}
    </Text>
  );
}

/** A small single-choice row (radio semantics). */
function Choice<V extends string>({
  label,
  options,
  value,
  onChange,
  error,
  testID,
}: {
  readonly label: string;
  readonly options: readonly { readonly value: V; readonly label: string }[];
  readonly value: V | '';
  readonly onChange: (v: V) => void;
  readonly error?: string | undefined;
  readonly testID: string;
}) {
  const t = useTheme();
  return (
    <View style={styles.field} accessibilityRole="radiogroup" accessibilityLabel={label}>
      <Text style={{ color: t.color.textSecondary, fontSize: 13, fontFamily: t.font.family }}>
        {label}
      </Text>
      <View style={styles.choices}>
        {options.map((o) => {
          const on = o.value === value;
          return (
            <Pressable
              key={o.value}
              testID={`${testID}-${o.value}`}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              accessibilityLabel={o.label}
              onPress={() => onChange(o.value)}
              style={[
                styles.choice,
                {
                  minHeight: t.size.minTouch,
                  borderRadius: t.platform === 'ios' ? 10 : 4,
                  borderColor: on
                    ? t.color.accent
                    : error
                      ? t.color.destructive
                      : t.color.separator,
                  backgroundColor: on ? t.color.tint : t.color.surface,
                },
              ]}
            >
              <Text
                style={{
                  color: on ? t.color.accent : t.color.text,
                  fontSize: 15,
                  fontFamily: t.font.family,
                }}
              >
                {o.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {error ? (
        <Text accessibilityLiveRegion="polite" style={{ color: t.color.destructive, fontSize: 13 }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

// ── Step 1: your details ───────────────────────────────────────────────────

const FLAG: Record<Country, string> = { US: '🇺🇸', IN: '🇮🇳' };

function DetailsStep({
  deps,
  onStarted,
  onRefused,
  onNotOpen,
}: {
  readonly deps: SignupDeps;
  readonly onStarted: (id: string, email: string, phone: string) => void;
  readonly onRefused: (email: string) => void;
  readonly onNotOpen: () => void;
}) {
  const t = useTheme();
  const now = deps.now ?? Date.now;
  // elapsed_ms: measured from this screen's mount to submit (untrusted risk input, M-A11).
  const mountedAt = useRef(now());
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [country, setCountry] = useState<Country>('US');
  const [phone, setPhone] = useState('');
  const [residence, setResidence] = useState<Residence>('');
  const [invite, setInvite] = useState('');
  const [inviteRequired, setInviteRequired] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const integrity = deps.integrity;

  useEffect(() => {
    integrity?.warmUp();
  }, [integrity]);

  if (integrity === null) {
    return (
      <View testID="signup-unavailable" style={styles.gap}>
        <Title>Create a free account</Title>
        <Body>{SIGNUP_COPY.unavailable}</Body>
      </View>
    );
  }

  if (showPrivacy) {
    // In place of the form, so the details typed so far (and elapsed_ms) are kept.
    return (
      <PrivacyNoticeView
        api={deps.api}
        crypto={deps.crypto ?? platformCrypto}
        onBack={() => setShowPrivacy(false)}
      />
    );
  }

  const clear = (k: FieldKey) =>
    setErrors((p) => {
      if (p[k] === undefined) return p;
      const n = { ...p };
      delete n[k];
      return n;
    });

  async function submit(session: IntegritySession): Promise<void> {
    const { errors: errs, e164 } = validateDetails({
      name,
      email,
      country,
      phone,
      residence,
      invite,
      inviteRequired,
    });
    setErrors(errs);
    setFailure(null);
    if (Object.keys(errs).length > 0 || e164 === null || residence === '') return;
    const body: NativeStartBody = {
      client: 'android',
      name: name.trim(),
      email: email.trim(),
      phone: e164,
      residence,
      invite_code: invite.trim() !== '' ? invite.trim() : null,
      hp: '',
      elapsed_ms: Math.max(0, Math.round(now() - mountedAt.current)),
    };
    setBusy(true);
    try {
      let token: string;
      try {
        token = await session.tokenFor(body);
      } catch {
        setFailure(SIGNUP_COPY.integrityFailed);
        return;
      }
      const r = await deps.api.start({ ...body, integrity_token: token });
      onStarted(r.signup_id, body.email, e164);
    } catch (e) {
      const err = asError(e);
      if (err === null || err.isNetwork) {
        setFailure(err ? refusalMessage(err) : SIGNUP_COPY.generic);
        return;
      }
      const f = startFailure(err);
      if (f.kind === 'not_open') return onNotOpen();
      // Neutral, non-enumerating: an explicit refusal shows the review screen.
      if (f.kind === 'refused') return onRefused(body.email);
      if (f.kind === 'invite_required' || f.kind === 'invite_invalid') {
        setInviteRequired(true);
        setErrors({ invite: startFailureMessage(f) ?? SIGNUP_COPY.generic });
        return;
      }
      if (f.kind === 'field') {
        const message = fieldMessage(f.field, country);
        if (message !== null) {
          setErrors({ [f.field === 'invite_code' ? 'invite' : f.field]: message });
          return;
        }
      }
      setFailure(startFailureMessage(f) ?? SIGNUP_COPY.generic);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.gap}>
      <Title>Tell us about you</Title>
      <Body>For your free personal account. 5 documents a month.</Body>
      <TextField
        label="Full name"
        testID="signup-name"
        value={name}
        maxLength={100}
        autoComplete="name"
        textContentType="name"
        onChangeText={(v) => {
          setName(v);
          clear('name');
        }}
        error={errors.name ?? null}
      />
      <TextField
        label="Personal email"
        testID="signup-email"
        value={email}
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        textContentType="emailAddress"
        onChangeText={(v) => {
          setEmail(v);
          clear('email');
        }}
        error={errors.email ?? null}
      />
      <Text style={[styles.help, { color: t.color.textSecondary }]}>{SIGNUP_COPY.emailHelp}</Text>
      <Choice<Country>
        label="Phone country"
        testID="signup-phone-country"
        options={COUNTRIES.map((c) => ({ value: c.code, label: `${FLAG[c.code]} ${c.dial}` }))}
        value={country}
        onChange={setCountry}
      />
      <TextField
        label="Mobile number"
        testID="signup-phone"
        value={phone}
        keyboardType="phone-pad"
        autoComplete="tel"
        textContentType="telephoneNumber"
        placeholder={country === 'US' ? '(415) 555-0100' : '98765 43210'}
        onChangeText={(v) => {
          setPhone(v);
          clear('phone');
        }}
        error={errors.phone ?? null}
      />
      <Text style={[styles.help, { color: t.color.textSecondary }]}>{SIGNUP_COPY.phoneHelp}</Text>
      <Choice<Country>
        label="Country of residence"
        testID="signup-residence"
        options={COUNTRIES.map((c) => ({ value: c.code, label: c.name }))}
        value={residence}
        onChange={(v) => {
          setResidence(v);
          clear('residence');
        }}
        error={errors.residence}
      />
      <TextField
        label="Invite code"
        {...(inviteRequired ? {} : { hint: '(optional) Only if you were invited to the pilot' })}
        testID="signup-invite"
        value={invite}
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={(v) => {
          setInvite(v);
          clear('invite');
        }}
        error={errors.invite ?? null}
      />
      {failure !== null ? <ErrorText testID="signup-failure">{failure}</ErrorText> : null}
      {/* Notice at the point of collection (Aramo Privacy Notice; Personal A1). */}
      <View testID="signup-privacy-notice" style={styles.gapSmall}>
        <Body>{SIGNUP_COPY.privacy}</Body>
        <Button
          variant="text"
          title="Privacy Notice"
          accessibilityHint="Shows the Privacy Notice"
          onPress={() => setShowPrivacy(true)}
          style={styles.start}
          testID="signup-privacy-link"
        />
      </View>
      <Button
        title={busy ? 'Sending code…' : 'Continue'}
        busy={busy}
        onPress={() => void submit(integrity)}
        testID="signup-submit"
      />
      {/* GeoLite2 licence attribution (network location is one signup risk signal). */}
      {/* Plain text, no link: there is no in-app third-party notices document. */}
      <Text
        testID="signup-maxmind"
        style={{ color: t.color.textTertiary, fontSize: 11, lineHeight: 15 }}
      >
        {SIGNUP_COPY.maxmind}
      </Text>
    </View>
  );
}

// ── One-time code steps ────────────────────────────────────────────────────

function useCountdown(seconds: number = RESEND_SECONDS): [number, () => void] {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    if (left <= 0) return undefined;
    const id = setTimeout(() => setLeft((v) => v - 1), 1000);
    return () => clearTimeout(id);
  }, [left]);
  return [left, () => setLeft(seconds)];
}

const fmtWait = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function CodeStep({
  title,
  sub,
  submitLabel,
  verify,
  resend,
  onNext,
  onRestart,
}: {
  readonly title: string;
  readonly sub: string;
  readonly submitLabel: string;
  readonly verify: (code: string) => Promise<NextStep>;
  readonly resend: () => Promise<boolean>;
  readonly onNext: (next: NextStep) => void;
  readonly onRestart: () => void;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restart, setRestart] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [left, resetTimer] = useCountdown();

  async function submit(): Promise<void> {
    if (!/^\d{6}$/.test(code)) {
      setError('Enter all 6 digits.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      onNext(await verify(code));
    } catch (e) {
      const err = asError(e);
      if (err === null || err.isNetwork) {
        setError(err ? refusalMessage(err) : SIGNUP_COPY.generic);
      } else {
        const f = codeFailureMessage(err);
        setError(f.message);
        setRestart(f.restart);
      }
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  async function again(): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      if (await resend()) {
        setNotice('We sent a new code.');
        resetTimer();
      }
    } catch (e) {
      const err = asError(e);
      if (err === null || err.isNetwork) {
        setError(err ? refusalMessage(err) : SIGNUP_COPY.generic);
        return;
      }
      const f = codeFailureMessage(err);
      setError(
        err.status === 429 ? 'You’ve asked for too many codes. Try again later.' : f.message,
      );
      setRestart(f.restart);
    }
  }

  if (restart) {
    return (
      <View testID="signup-code-restart" style={styles.gap}>
        <Title>Too many tries</Title>
        <Body>{error ?? 'Start again to get a new code.'}</Body>
        <Button title="Start again" onPress={onRestart} testID="signup-restart" />
      </View>
    );
  }

  return (
    <View style={styles.gap}>
      <Title>{title}</Title>
      <Body>{sub}</Body>
      <TextField
        label="6-digit code"
        testID="signup-code"
        value={code}
        keyboardType="number-pad"
        maxLength={6}
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        onChangeText={(v) => {
          setCode(v.replace(/\D/g, '').slice(0, 6));
          setError(null);
        }}
        error={error}
      />
      <Button
        variant="text"
        title={left > 0 ? `Resend in ${fmtWait(left)}` : 'Didn’t get it? Resend'}
        disabled={left > 0}
        onPress={() => void again()}
        style={styles.start}
        testID="signup-resend"
      />
      {notice !== null ? <Body testID="signup-code-notice">{notice}</Body> : null}
      <Button
        title={busy ? 'Checking…' : submitLabel}
        busy={busy}
        disabled={code.length !== 6}
        onPress={() => void submit()}
        testID="signup-code-submit"
      />
    </View>
  );
}

function PhoneStep({
  id,
  api,
  masked,
  onNext,
  onUnavailable,
  onRestart,
}: {
  readonly id: string;
  readonly api: SignupApi;
  readonly masked: string;
  readonly onNext: (next: NextStep) => void;
  readonly onUnavailable: () => void;
  readonly onRestart: () => void;
}) {
  const [sent, setSent] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const once = useRef(false);

  useEffect(() => {
    // One send per screen (the guard also covers a changed onUnavailable identity).
    if (once.current) return;
    once.current = true;
    api
      .sendPhoneCode(id)
      .then((ok) => (ok ? setSent(true) : onUnavailable()))
      .catch((e: unknown) => {
        const err = asError(e);
        setError(
          err === null
            ? SIGNUP_COPY.generic
            : err.isNetwork
              ? refusalMessage(err)
              : codeFailureMessage(err).message,
        );
      });
  }, [api, id, onUnavailable]);

  if (error !== null) {
    return (
      <View testID="signup-phone-error" style={styles.gap}>
        <Title>{SIGNUP_COPY.phoneSendFailed}</Title>
        <ErrorText>{error}</ErrorText>
        <Button title="Start again" onPress={onRestart} />
      </View>
    );
  }
  if (sent === null) return <Body>Sending a code to your phone…</Body>;
  return (
    <CodeStep
      title="Verify your phone"
      sub={`We texted a 6-digit code to ${masked}. Only some new accounts need this step.`}
      submitLabel="Verify phone"
      verify={(code) => api.verifyPhone(id, code)}
      resend={() =>
        api.sendPhoneCode(id).then((ok) => {
          if (!ok) onUnavailable();
          return ok;
        })
      }
      onNext={onNext}
      onRestart={onRestart}
    />
  );
}

// ── Terms (Lead correction 3: key, version and hash bound) ──────────────────

type Docs =
  | { state: 'loading' }
  | { state: 'ready'; docs: readonly TermsText[] }
  | { state: 'failed' };

/**
 * The bound text of one listed document. Refused (throws) unless the text endpoint names the
 * listed key, version and sha256, and the text's UTF-8 bytes hash to that sha256.
 */
async function verifiedText(
  api: SignupApi,
  crypto: Pick<CryptoPort, 'sha256'>,
  listed: TermsListDocument,
): Promise<TermsText> {
  const t = await api.termsText(listed.key, listed.version);
  const actual = toHex(await crypto.sha256(utf8Encode(t.text)));
  if (
    t.key !== listed.key ||
    t.version !== listed.version ||
    t.sha256.toLowerCase() !== listed.sha256.toLowerCase() ||
    actual !== t.sha256.toLowerCase()
  )
    throw new Error('terms_text_mismatch');
  return t;
}

/** Fetch every effective Personal document's text; refuse any whose text does not hash to its sha256. */
async function loadTerms(
  api: SignupApi,
  crypto: Pick<CryptoPort, 'sha256'>,
): Promise<'off' | 'not_approved' | readonly TermsText[]> {
  const list = await api.listTerms();
  if (list.off) return 'off';
  if (list.documents === null) return 'not_approved';
  return Promise.all(list.documents.map((d) => verifiedText(api, crypto, d)));
}

const PRIVACY_NOTICE_KEY = 'aramo.privacy_notice';

/** The currently effective Privacy Notice, verified like the terms step (null: none listed). */
async function loadPrivacyNotice(
  api: SignupApi,
  crypto: Pick<CryptoPort, 'sha256'>,
): Promise<TermsText | null> {
  const list = await api.listTerms();
  const listed = list.off ? undefined : list.documents?.find((d) => d.key === PRIVACY_NOTICE_KEY);
  return listed === undefined ? null : verifiedText(api, crypto, listed);
}

/** One document's text, rendered as plain text (the terms step and the Privacy Notice view). */
function DocumentText({ doc }: { readonly doc: TermsText }) {
  const t = useTheme();
  return (
    <View
      testID={`signup-doc-${doc.key}`}
      style={[styles.doc, { backgroundColor: t.color.surface, borderRadius: t.size.cardRadius }]}
    >
      <Text
        accessibilityRole="header"
        style={{ color: t.color.text, fontSize: 17, fontWeight: '600' }}
      >
        {`${documentLabel(doc.key)} (version ${doc.version})`}
      </Text>
      <Text selectable style={{ color: t.color.text, fontSize: 14, lineHeight: 20 }}>
        {doc.text}
      </Text>
    </View>
  );
}

/** The Privacy Notice at the point of collection, in-app (no browser). */
function PrivacyNoticeView({
  api,
  crypto,
  onBack,
}: {
  readonly api: SignupApi;
  readonly crypto: Pick<CryptoPort, 'sha256'>;
  readonly onBack: () => void;
}) {
  const [doc, setDoc] = useState<TermsText | 'loading' | 'failed'>('loading');
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let live = true;
    loadPrivacyNotice(api, crypto)
      .then((d) => live && setDoc(d ?? 'failed'))
      .catch(() => live && setDoc('failed'));
    return () => {
      live = false;
    };
  }, [api, crypto, generation]);

  const back = (
    <Button
      variant="text"
      title="Back"
      onPress={onBack}
      style={styles.start}
      testID="signup-privacy-back"
    />
  );
  return (
    <View testID="signup-privacy-view" style={styles.gap}>
      {back}
      {doc === 'loading' ? (
        <Body testID="signup-privacy-loading">Loading the Privacy Notice…</Body>
      ) : doc === 'failed' ? (
        <>
          <ErrorText testID="signup-privacy-failed">{SIGNUP_COPY.privacyLoadFailed}</ErrorText>
          <Button
            title="Try again"
            onPress={() => {
              setDoc('loading');
              setGeneration((g) => g + 1);
            }}
            testID="signup-privacy-retry"
          />
        </>
      ) : (
        <>
          <DocumentText doc={doc} />
          {back}
        </>
      )}
    </View>
  );
}

function TermsStep({
  id,
  api,
  crypto,
  notice,
  onDone,
  onRefused,
  onNotOpen,
  onRestart,
}: {
  readonly id: string;
  readonly api: SignupApi;
  readonly crypto: Pick<CryptoPort, 'sha256'>;
  readonly notice?: string;
  readonly onDone: (held: Held | undefined) => void;
  readonly onRefused: () => void;
  readonly onNotOpen: () => void;
  readonly onRestart: () => void;
}) {
  const t = useTheme();
  const [docs, setDocs] = useState<Docs>({ state: 'loading' });
  const [notApproved, setNotApproved] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [expired, setExpired] = useState(false);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let live = true;
    loadTerms(api, crypto)
      .then((r) => {
        if (!live) return;
        if (r === 'off') onNotOpen();
        else if (r === 'not_approved') setNotApproved(true);
        else setDocs({ state: 'ready', docs: r });
      })
      .catch(() => live && setDocs({ state: 'failed' }));
    return () => {
      live = false;
    };
    // onNotOpen is stable enough for a one-shot load per generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, crypto, generation]);

  const reload = () => {
    setAgreed(false);
    setDocs({ state: 'loading' });
    setGeneration((g) => g + 1);
  };

  async function submit(list: readonly TermsText[]): Promise<void> {
    if (!agreed) return;
    setBusy(true);
    setError(null);
    try {
      const accept: AcceptEntry[] = list.map((d) => ({
        key: d.key,
        version: d.version,
        sha256: d.sha256,
      }));
      const r = await api.complete(id, accept);
      if (r.status === 'PROVISIONED') onDone(r.held);
      else setError(SIGNUP_COPY.stillCreating);
    } catch (e) {
      const err = asError(e);
      if (err === null || err.isNetwork) {
        setError(err ? refusalMessage(err) : SIGNUP_COPY.generic);
        return;
      }
      if (err.reason === 'terms_not_accepted') {
        // A document changed after it was shown: show the current versions and ask again.
        setChanged(true);
        reload();
        return;
      }
      if (err.reason === 'legal_documents_not_approved') return setNotApproved(true);
      if (err.reason === 'personal_signup_refused') return onRefused();
      if (err.status === 404) return setExpired(true);
      if (err.status === 409) return setError(SIGNUP_COPY.emailTaken);
      if (err.reason === 'invite_invalid') return setError(SIGNUP_COPY.inviteInvalid);
      if (err.reason === 'personal_pilot_full') return setError(SIGNUP_COPY.pilotFull);
      setError(SIGNUP_COPY.generic);
    } finally {
      setBusy(false);
    }
  }

  if (expired) {
    return (
      <View testID="signup-expired" style={styles.gap}>
        <Title>{SIGNUP_COPY.expiredTitle}</Title>
        <Body>{SIGNUP_COPY.expiredBody}</Body>
        <Button title="Start again" onPress={onRestart} testID="signup-restart" />
      </View>
    );
  }
  if (notApproved) {
    return (
      <View testID="signup-terms-unavailable" style={styles.gap}>
        <Title>{SIGNUP_COPY.notOpen}</Title>
        <Body>{SIGNUP_COPY.termsUnavailable}</Body>
      </View>
    );
  }
  if (docs.state === 'loading')
    return <Body testID="signup-terms-loading">Loading the terms…</Body>;
  if (docs.state === 'failed') {
    return (
      <View style={styles.gap}>
        <ErrorText testID="signup-terms-failed">{SIGNUP_COPY.termsLoadFailed}</ErrorText>
        <Button title="Try again" onPress={reload} testID="signup-terms-retry" />
      </View>
    );
  }
  return (
    <View style={styles.gap}>
      <Title>Review and accept</Title>
      <Body>Read these before you create your account.</Body>
      {notice !== undefined ? <Banner tone="offline" body={notice} /> : null}
      {changed ? <Banner tone="limit" body={SIGNUP_COPY.termsChanged} /> : null}
      {docs.docs.map((d) => (
        <DocumentText key={`${d.key}@${d.version}`} doc={d} />
      ))}
      <Body testID="signup-plan">
        Free plan · 5 documents a month · up to 2 a day. The free plan may change. We’ll tell you
        before it does.
      </Body>
      <CheckRow
        checked={agreed}
        onToggle={() => setAgreed((v) => !v)}
        accessibilityLabel="I agree to these documents."
        testID="signup-accept"
      >
        <Text style={{ color: t.color.text, fontSize: 15 }}>I agree to these documents.</Text>
      </CheckRow>
      {error !== null ? <ErrorText testID="signup-terms-error">{error}</ErrorText> : null}
      <Button
        title="Create account"
        busy={busy}
        disabled={!agreed}
        onPress={() => void submit(docs.docs)}
        testID="signup-complete"
      />
    </View>
  );
}

// ── Done: the existing Google sign-in (M-A11 §1 step 5, D-3) ────────────────

function DoneStep({
  email,
  held,
  signIn,
}: {
  readonly email: string;
  readonly held: Held;
  readonly signIn: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await signIn();
    } catch (e) {
      const err = asError(e);
      if (err?.reason !== 'auth_cancelled')
        setError(err ? refusalMessage(err) : SIGNUP_COPY.generic);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.gap}>
      <Title>{SIGNUP_COPY.doneTitle}</Title>
      <Body testID="signup-done-copy">{SIGNUP_COPY.doneBody(email)}</Body>
      {held !== null ? (
        <Banner tone="limit" title={HELD_COPY[held].title} body={HELD_COPY[held].note} />
      ) : null}
      <Body>{SIGNUP_COPY.doneInactive}</Body>
      {isGmail(email) ? <Body testID="signup-done-gmail">{SIGNUP_COPY.gmail}</Body> : null}
      {error !== null ? <ErrorText testID="signup-done-error">{error}</ErrorText> : null}
      <Button
        title={busy ? 'Signing in…' : 'Continue with Google'}
        busy={busy}
        onPress={() => void go()}
        testID="signup-continue-google"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { gap: 16, paddingHorizontal: 20, paddingTop: 20 },
  gap: { gap: 14 },
  gapSmall: { gap: 2 },
  field: { gap: 6 },
  choices: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  choice: { borderWidth: 1, paddingHorizontal: 14, justifyContent: 'center' },
  help: { fontSize: 13, lineHeight: 18, marginTop: -8 },
  start: { alignSelf: 'flex-start' },
  doc: { gap: 8, padding: 14 },
});
