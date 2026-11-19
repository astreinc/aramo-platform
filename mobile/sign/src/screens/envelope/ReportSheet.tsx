// Amendment M-A7 §5.2 (R-11) — "Report this envelope" (the received-envelope view and,
// UAT SIG-14, the signing screen). UAT SIG-14 retest (web ≡ app): the same form and
// confirmation as the web report page (apps/sign-web/src/workspace/routes/ReportPage.tsx):
// an optional reason, an optional note (500 characters, as the web), "Send report", then
// "Thanks — we'll look into it" with the Acceptable Use Policy link. Reports go to Aramo;
// the sender is never told (M-A7 §5.2).
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Button } from '../../components/Button';
import { Sheet } from '../../components/Sheet';
import { WEB_LINKS } from '../../config/env';
import { REPORT_REASONS, type ReportReasonKey } from '../../features/inbox/inboxReport';
import { TextField } from '../../features/send/ui';
import { useTheme } from '../../theme';

/** The note's limit, as the web report page (the server accepts up to 1000). */
export const REPORT_NOTE_MAX = 500;

/** The confirmation, as the web report page. */
export const REPORT_THANKS = {
  title: 'Thanks — we’ll look into it',
  sent: 'Your report was sent. ',
  already: 'We already have your report about this envelope. ',
  rest: 'You don’t need to do anything else. Don’t open links or sign documents from an email you don’t trust.',
} as const;

/** What the caller's send returns: a confirmation, or a message to show on the form. */
export type ReportSendResult = { readonly kind: 'sent' | 'already' } | { readonly kind: 'error'; readonly message: string };

export function ReportSheet({
  visible,
  busy,
  onSend,
  onClose,
}: {
  readonly visible: boolean;
  readonly busy: boolean;
  readonly onSend: (reason: ReportReasonKey | null, note: string) => Promise<ReportSendResult>;
  readonly onClose: () => void;
}) {
  const t = useTheme();
  const [reason, setReason] = useState<ReportReasonKey | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<'sent' | 'already' | null>(null);

  // A fresh form the next time the sheet opens.
  function close(): void {
    setReason(null);
    setNote('');
    setError(null);
    setDone(null);
    onClose();
  }

  async function send(): Promise<void> {
    setError(null);
    const r = await onSend(reason, note.trim());
    if (r.kind === 'error') setError(r.message);
    else setDone(r.kind);
  }

  const body = { color: t.color.textSecondary, fontSize: 15, lineHeight: 21, fontFamily: t.font.family } as const;
  const aup = (
    <Text testID="report-aup" style={{ ...body, fontSize: 13, lineHeight: 19 }}>
      {'What isn’t allowed on Aramo Sign is set out in our '}
      <Text
        accessibilityRole="link"
        style={{ color: t.color.accent, fontWeight: '600' }}
        onPress={() => void WebBrowser.openBrowserAsync(WEB_LINKS.acceptableUse).catch(() => undefined)}
      >
        Acceptable Use Policy
      </Text>
      .
    </Text>
  );

  if (done !== null) {
    return (
      <Sheet visible={visible} onClose={close} title={REPORT_THANKS.title}>
        <Text testID="report-thanks" style={body}>
          {(done === 'already' ? REPORT_THANKS.already : REPORT_THANKS.sent) + REPORT_THANKS.rest}
        </Text>
        {aup}
        <Button testID="report-done" title="Done" onPress={close} />
      </Sheet>
    );
  }

  return (
    <Sheet visible={visible} onClose={close} title="Report this envelope">
      <Text style={body}>What’s wrong with it? (optional) Aramo reviews every report.</Text>
      <View accessibilityRole="radiogroup">
        {REPORT_REASONS.map((r, i) => {
          const on = r.key === reason;
          return (
            <Pressable
              key={r.key}
              testID={`report-reason-${r.key}`}
              onPress={() => setReason(on ? null : r.key)}
              disabled={busy}
              accessibilityRole="radio"
              accessibilityState={{ checked: on, disabled: busy }}
              accessibilityLabel={r.label}
              accessibilityHint={r.sub}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                minHeight: t.size.minTouch,
                paddingVertical: 8,
                borderBottomWidth: i < REPORT_REASONS.length - 1 ? t.size.separatorWidth : 0,
                borderBottomColor: t.color.separator,
              }}
            >
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.color.text, fontSize: 16, fontWeight: '600', fontFamily: t.font.family }}>
                  {r.label}
                </Text>
                <Text style={{ color: t.color.textSecondary, fontSize: 13, fontFamily: t.font.family }}>{r.sub}</Text>
              </View>
              <Text style={{ color: t.color.accent, fontSize: 17, fontWeight: '600' }}>{on ? '✓' : ''}</Text>
            </Pressable>
          );
        })}
      </View>
      <TextField
        testID="report-note"
        label="Anything else? (optional)"
        value={note}
        onChangeText={setNote}
        multiline
        maxLength={REPORT_NOTE_MAX}
        style={{ minHeight: 88, textAlignVertical: 'top' }}
        error={error}
        accessibilityHint={`Up to ${REPORT_NOTE_MAX} characters`}
      />
      <Text
        testID="report-note-count"
        accessibilityLiveRegion="polite"
        style={{ color: t.color.textSecondary, fontSize: 13, textAlign: 'right', fontFamily: t.font.family }}
      >
        {`${note.length} / ${REPORT_NOTE_MAX}`}
      </Text>
      <Button testID="report-send" title="Send report" busy={busy} onPress={() => void send()} />
      <Button title="Cancel" variant="text" onPress={close} disabled={busy} />
      {aup}
    </Sheet>
  );
}
