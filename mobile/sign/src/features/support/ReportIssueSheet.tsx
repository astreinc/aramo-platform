// M-A12 W1-E.3 — the "Report app issue" sheet. The device facts come from the OS; the
// message is the only thing the user types. Nothing else is attached.
import * as Application from 'expo-application';
import * as Device from 'expo-device';
import { useState } from 'react';
import { Platform, Text } from 'react-native';

import { useServices } from '../../app/ServicesContext';
import { Button } from '../../components/Button';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { useTheme } from '../../theme';
import { TextField } from '../send/ui';
import { ISSUE_COPY, ISSUE_MAX, issueBody, sendAppIssue, validIssue } from './appIssue';

export function deviceFacts() {
  return {
    appVersion: Application.nativeApplicationVersion ?? null,
    os: Platform.OS,
    osVersion: Device.osVersion ?? Platform.Version ?? null,
    deviceModel: Device.modelName ?? null,
  };
}

export function ReportIssueSheet({
  visible,
  onClose,
  screen,
  online,
}: {
  readonly visible: boolean;
  readonly onClose: () => void;
  /** The screen the report was opened from (a route name, never content). */
  readonly screen: string;
  readonly online: boolean;
}) {
  const t = useTheme();
  const toast = useToast();
  const { workspace } = useServices();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(): Promise<void> {
    setBusy(true);
    setError(null);
    const r = await sendAppIssue(workspace, issueBody(message, deviceFacts(), screen));
    setBusy(false);
    if (r.ok) {
      setMessage('');
      onClose();
      toast.show(ISSUE_COPY.sent);
    } else setError(r.message);
  }

  return (
    <Sheet visible={visible} onClose={onClose} title="Report app issue">
      <Text style={{ color: t.color.textSecondary, fontSize: 14, lineHeight: 20, fontFamily: t.font.family }}>
        {ISSUE_COPY.note}
      </Text>
      <TextField
        testID="issue-message"
        label="What happened?"
        value={message}
        onChangeText={setMessage}
        multiline
        maxLength={ISSUE_MAX}
        style={{ minHeight: 120, textAlignVertical: 'top' }}
        error={error}
      />
      <Button
        testID="issue-send"
        title="Send"
        busy={busy}
        disabled={!online || !validIssue(message)}
        onPress={() => void send()}
      />
      <Button title="Cancel" variant="text" onPress={onClose} />
    </Sheet>
  );
}
