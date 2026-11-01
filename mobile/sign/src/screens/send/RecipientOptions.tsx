// Consolidated Directive v1.0 B2 — per-recipient options in the Send flow, each shown
// ONLY while the sender context reports it available (features/send/sendFeatures.ts):
//   - Witness: the signer this witness signs for;
//   - Access code: set, change or remove (SIGNER and WITNESS);
//   - Identity check: None / ID check / Questions (SIGNER and WITNESS);
//   - Text delivery: Email / Email + SMS / Email + WhatsApp, the SMS code, and the phone
//     number in international format (SIGNER only).
// The server decides every choice again; its refusal is shown by reason (ROLE_COPY).
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '../../components/Button';
import { Segments, SettingRow } from '../../features/inbox/ui';
import { NO_MESSAGING, type DraftRecipient, type IdentityCheck, type TextChannel } from '../../features/send/draftModel';
import {
  ACCESS_CODE_MAX,
  ACCESS_CODE_MIN,
  isWitness,
  PHONE_HINT,
  takesLinkChecks,
  takesMessaging,
  validAccessCode,
  validPhone,
  witnessTargets,
} from '../../features/send/recipientRoles';
import type { SendFeatures } from '../../features/send/sendFeatures';
import type { SendFlowController } from '../../features/send/sendFlowController';
import { TextField } from '../../features/send/ui';
import { useTheme } from '../../theme';

export const WITNESS_PICK_HINT = 'Choose the signer this witness signs for.';
export const ACCESS_CODE_RULE = `${ACCESS_CODE_MIN} to ${ACCESS_CODE_MAX} letters, numbers or symbols. Share it with them yourself.`;

type IdentityKey = 'NONE' | IdentityCheck;
type ChannelKey = 'EMAIL' | TextChannel;

/** True when any option applies to this recipient. */
export function hasOptions(r: DraftRecipient, f: SendFeatures): boolean {
  return (
    (f.witness && isWitness(r)) ||
    (takesLinkChecks(r) && (f.accessCode || f.idCheck || f.kba)) ||
    (takesMessaging(r) && (f.sms || f.whatsapp || f.smsCode))
  );
}

function Label({ children }: { readonly children: string }) {
  const t = useTheme();
  return (
    <Text style={{ color: t.color.textSecondary, fontSize: 13, fontFamily: t.font.family }}>
      {children}
    </Text>
  );
}

function WitnessPicker({
  r,
  list,
  controller,
}: {
  readonly r: DraftRecipient;
  readonly list: readonly DraftRecipient[];
  readonly controller: SendFlowController;
}) {
  const t = useTheme();
  const targets = witnessTargets(list, r.key);
  return (
    <View style={{ gap: 6 }}>
      <Label>Witness for</Label>
      <View style={styles.wrap} accessibilityRole="radiogroup" accessibilityLabel={`Who ${r.name} witnesses`}>
        {targets.map((x) => {
          const on = r.witnessForKey === x.key;
          return (
            <Pressable
              key={x.key}
              testID={`witness-${r.key}-${x.key}`}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`Witness for ${x.name}`}
              onPress={() => controller.setWitnessFor(r.key, x.key)}
              style={[
                styles.chip,
                {
                  minHeight: t.size.minTouch,
                  borderColor: on ? t.color.accent : t.color.separator,
                  backgroundColor: on ? t.color.tint : 'transparent',
                },
              ]}
            >
              <Text style={{ color: on ? t.color.onTint : t.color.text, fontSize: 14, fontFamily: t.font.family }}>
                {on ? `✓ ${x.name}` : x.name}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {!r.witnessForKey ? (
        <Text testID={`witness-hint-${r.key}`} style={{ color: t.color.destructive, fontSize: 13 }}>
          {targets.length === 0 ? 'Add a signer first.' : WITNESS_PICK_HINT}
        </Text>
      ) : null}
    </View>
  );
}

function AccessCode({ r, controller }: { readonly r: DraftRecipient; readonly controller: SendFlowController }) {
  const t = useTheme();
  const [editing, setEditing] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const has = r.accessCode !== undefined ? r.accessCode !== null : r.accessCodeSet === true;
  if (editing) {
    return (
      <View style={{ gap: 6 }}>
        <TextField
          label="Access code"
          testID={`access-code-input-${r.key}`}
          value={code}
          onChangeText={setCode}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={64}
          error={error}
        />
        <Text style={{ color: t.color.textSecondary, fontSize: 13 }}>{ACCESS_CODE_RULE}</Text>
        <View style={styles.row}>
          <Button title="Cancel" variant="text" onPress={() => setEditing(false)} />
          <Button
            title="Save code"
            testID={`access-code-save-${r.key}`}
            disabled={code.trim().length === 0}
            onPress={() => {
              if (!validAccessCode(code) || !controller.setAccessCode(r.key, code)) {
                setError(ACCESS_CODE_RULE);
                return;
              }
              setCode('');
              setError(null);
              setEditing(false);
            }}
          />
        </View>
      </View>
    );
  }
  return (
    <View style={styles.between}>
      <Text testID={`access-code-state-${r.key}`} style={{ color: t.color.text, fontSize: 14, fontFamily: t.font.family, flex: 1 }}>
        {has ? 'Access code set' : 'No access code'}
      </Text>
      <Button
        title={has ? 'Change' : 'Add access code'}
        variant="text"
        testID={`access-code-edit-${r.key}`}
        onPress={() => {
          setCode('');
          setError(null);
          setEditing(true);
        }}
      />
      {has ? (
        <Button
          title="Remove"
          variant="text"
          testID={`access-code-remove-${r.key}`}
          onPress={() => controller.setAccessCode(r.key, null)}
        />
      ) : null}
    </View>
  );
}

function TextDelivery({
  r,
  f,
  controller,
}: {
  readonly r: DraftRecipient;
  readonly f: SendFeatures;
  readonly controller: SendFlowController;
}) {
  const t = useTheme();
  const m = r.messaging ?? NO_MESSAGING;
  const channels: { key: ChannelKey; label: string }[] = [
    { key: 'EMAIL', label: 'Email' },
    ...(f.sms ? [{ key: 'SMS' as const, label: 'Email + SMS' }] : []),
    ...(f.whatsapp ? [{ key: 'WHATSAPP' as const, label: 'Email + WhatsApp' }] : []),
  ];
  const needsPhone = m.channel !== null || m.smsOtp;
  const phoneError = needsPhone && m.phone.trim().length > 0 && !validPhone(m.phone) ? PHONE_HINT : null;
  return (
    <View style={{ gap: 8 }}>
      {channels.length > 1 ? (
        <View style={{ gap: 6 }}>
          <Label>Send the link by</Label>
          <Segments
            items={channels}
            value={m.channel ?? 'EMAIL'}
            onChange={(k) => controller.setMessaging(r.key, { channel: k === 'EMAIL' ? null : k })}
            testIDPrefix={`channel-${r.key}`}
          />
        </View>
      ) : null}
      {f.smsCode ? (
        <SettingRow
          title="Require an SMS code"
          subtitle="They enter a code sent to their phone before signing."
          value={m.smsOtp}
          onValueChange={(v) => controller.setMessaging(r.key, { smsOtp: v })}
          testID={`sms-code-${r.key}`}
          last
        />
      ) : null}
      {needsPhone ? (
        <View style={{ gap: 4 }}>
          <TextField
            label="Mobile number"
            testID={`phone-${r.key}`}
            value={m.phone}
            onChangeText={(v) => controller.setMessaging(r.key, { phone: v })}
            keyboardType="phone-pad"
            autoComplete="tel"
            placeholder="+14155550123"
            error={phoneError}
          />
          {m.phone.trim().length === 0 ? (
            <Text style={{ color: t.color.textSecondary, fontSize: 13 }}>{PHONE_HINT}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export function RecipientOptions({
  r,
  list,
  features: f,
  controller,
}: {
  readonly r: DraftRecipient;
  readonly list: readonly DraftRecipient[];
  readonly features: SendFeatures;
  readonly controller: SendFlowController;
}) {
  if (!hasOptions(r, f)) return null;
  const identities: { key: IdentityKey; label: string }[] = [
    { key: 'NONE', label: 'None' },
    ...(f.idCheck ? [{ key: 'ID_VERIFICATION' as const, label: 'ID check' }] : []),
    ...(f.kba ? [{ key: 'KBA' as const, label: 'Questions' }] : []),
  ];
  return (
    <View style={{ gap: 12 }} testID={`options-${r.key}`}>
      {f.witness && isWitness(r) ? <WitnessPicker r={r} list={list} controller={controller} /> : null}
      {f.accessCode && takesLinkChecks(r) ? <AccessCode r={r} controller={controller} /> : null}
      {(f.idCheck || f.kba) && takesLinkChecks(r) ? (
        <View style={{ gap: 6 }}>
          <Label>Identity check</Label>
          <Segments
            items={identities}
            value={r.identityCheck ?? 'NONE'}
            onChange={(k) => controller.setIdentityCheck(r.key, k === 'NONE' ? null : k)}
            testIDPrefix={`identity-${r.key}`}
          />
        </View>
      ) : null}
      {(f.sms || f.whatsapp || f.smsCode) && takesMessaging(r) ? (
        <TextDelivery r={r} f={f} controller={controller} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  between: { flexDirection: 'row', alignItems: 'center', gap: 4 },
});
