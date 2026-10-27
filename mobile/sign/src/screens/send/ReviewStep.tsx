// Step 4 "Review and send" (handoff §4.6; directive §5, §7 C-14, C-16):
//   - Subject (prefilled "{first document} — {first signer}") and an optional plain-
//     text Message (at most 1000 characters; saved with PATCH + If-Match).
//   - Summary: documents, recipients and their field counts, routing, "Signing link
//     valid for 7 days" and, separately, the envelope expiry the server reports (C-14).
//   - "Before you send": the blocking warnings, the Personal limit and the backend's
//     refusal reason. Send is disabled while any applies, offline, or busy.
import { StyleSheet, Text, View } from 'react-native';

import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { BANNER, useTheme } from '../../theme';
import type { LimitBanner } from '../../features/inbox/allowance';
import { MESSAGE_MAX, effectiveSubject, isCopyRecipient } from '../../features/send/draftModel';
import { reviewWarnings } from '../../features/send/reviewWarnings';
import type { SendFlowController, SendFlowState } from '../../features/send/sendFlowController';
import { ErrorText, StepTitle, TextField } from '../../features/send/ui';

export const SIGNING_LINK_DAYS_DEFAULT = 7;

function SummaryRow({ label, value }: { readonly label: string; readonly value: string }) {
  const t = useTheme();
  return (
    <View style={[styles.summaryRow, { borderBottomColor: t.color.separator, borderBottomWidth: t.size.separatorWidth }]}>
      <Text style={{ color: t.color.textSecondary, fontSize: 13, fontFamily: t.font.family }}>{label}</Text>
      <Text style={{ color: t.color.text, fontSize: 15, lineHeight: 21, fontFamily: t.font.family }}>{value}</Text>
    </View>
  );
}

export function ReviewStep({
  controller,
  state,
  limit,
  online,
  onSend,
  onSaveDraft,
}: {
  readonly controller: SendFlowController;
  readonly state: SendFlowState;
  readonly limit: LimitBanner | null;
  readonly online: boolean;
  readonly onSend: () => void;
  readonly onSaveDraft: () => void;
}) {
  const t = useTheme();
  const p = state.draft?.payload;
  if (!p) return null;
  const warnings = reviewWarnings(p, limit, state.refusal);
  const days = state.server?.signingLinkValidDays ?? SIGNING_LINK_DAYS_DEFAULT;
  const expiry = state.server?.envelopeExpiresAt;
  const busy = state.busy !== null;
  const sendDisabled = warnings.length > 0 || !online || busy;
  const fieldCount = (key: string) => p.fields.filter((f) => f.recipientKey === key).length;

  return (
    <View style={styles.body}>
      {limit ? <Banner title={limit.title} body={limit.body} /> : null}
      <StepTitle>Review and send</StepTitle>
      <TextField
        label="Subject"
        value={effectiveSubject(p)}
        onChangeText={(s) => controller.setSubject(s)}
        maxLength={200}
        placeholder="Subject"
      />
      <TextField
        label="Message"
        hint="(optional)"
        value={p.message}
        onChangeText={(m) => controller.setMessage(m)}
        multiline
        maxLength={MESSAGE_MAX}
        placeholder="Add a note for the signers"
        style={styles.message}
        accessibilityHint={`Plain text, up to ${MESSAGE_MAX} characters`}
      />
      <Text style={[styles.counter, { color: t.color.textSecondary }]}>{`${p.message.length} / ${MESSAGE_MAX}`}</Text>

      <Card>
        <SummaryRow
          label="Documents"
          value={
            p.documents
              .map((d) => (d.pages ? `${d.title} · ${d.pages.length} ${d.pages.length === 1 ? 'page' : 'pages'}` : d.title))
              .join('\n') || 'None'
          }
        />
        <SummaryRow
          label={p.routingMode === 'SEQUENTIAL' ? 'Recipients (sign in this order)' : 'Recipients'}
          value={
            p.recipients
              .map((r, i) => {
                // A copy recipient (template CC role, M-A5) never signs.
                if (isCopyRecipient(r)) return `${r.name} · Gets a copy`;
                const n = fieldCount(r.key);
                const who = p.routingMode === 'SEQUENTIAL' ? `${i + 1}. ${r.name}` : r.name;
                return `${who} · ${n} ${n === 1 ? 'field' : 'fields'}`;
              })
              .join('\n') || 'None'
          }
        />
        <SummaryRow label="Signing link" value={`Signing link valid for ${days} days`} />
        <SummaryRow
          label="Envelope expiry"
          value={expiry ? `Expires ${new Date(expiry).toLocaleDateString()}` : 'Set when you send'}
        />
      </Card>

      {warnings.length > 0 ? (
        <View accessibilityRole="alert" style={[styles.warn, { backgroundColor: BANNER.limit.bg, borderRadius: t.size.cardRadius }]}>
          <Text style={[styles.warnTitle, { color: BANNER.limit.fg }]}>Before you send</Text>
          {warnings.map((w) => (
            <Text key={`${w.kind}:${w.text}`} style={{ color: BANNER.limit.fg, fontSize: 14, lineHeight: 21 }}>
              {`• ${w.text}`}
            </Text>
          ))}
        </View>
      ) : null}
      <ErrorText>{state.error}</ErrorText>
      {!online ? (
        <Text style={{ color: t.color.textSecondary, fontSize: 14 }}>
          You’re offline. Your changes are saved on this phone. Connect to send.
        </Text>
      ) : null}
      <Button
        title="Send for signature"
        onPress={onSend}
        busy={state.busy === 'sending' || state.busy === 'syncing'}
        disabled={sendDisabled}
        testID="send-button"
      />
      <Button title="Save as draft" variant="text" onPress={onSaveDraft} disabled={busy} />
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: 14, padding: 16 },
  message: { minHeight: 96, textAlignVertical: 'top' },
  counter: { fontSize: 12, alignSelf: 'flex-end', marginTop: -8 },
  summaryRow: { paddingHorizontal: 16, paddingVertical: 10, gap: 2 },
  warn: { padding: 14, gap: 4 },
  warnTitle: { fontWeight: '600', fontSize: 14 },
});
