// M-A7 §3.3 — a deletion request's receipt: the request ID, its status, the server's outcome
// text and what is kept and why. Shown in the Account sheet (Business, or an open request) and,
// after a deletion that signed the user out, on the signed-out screen (APP-DELETED-1 A1).
import { Text, View } from 'react-native';

import { Button } from '../../components/Button';
import { ARAMO_SIGN_IDENTITY } from '../../config/identity';
import { useTheme } from '../../theme';

import { DELETE_ACCOUNT_URL, type PrivacyRequest } from './privacy';

export function DeletionReceipt({
  request,
  doneLabel,
  onDone,
}: {
  readonly request: PrivacyRequest;
  readonly doneLabel: string;
  readonly onDone: () => void;
}) {
  const t = useTheme();
  const text = { color: t.color.textSecondary, fontSize: 15, lineHeight: 21 } as const;
  return (
    <View testID="delete-account-result" style={{ gap: 6 }}>
      <Text style={text}>Request ID</Text>
      <Text testID="delete-account-reference" selectable style={{ color: t.color.text, fontSize: 17, fontWeight: '600' }}>
        {request.reference}
      </Text>
      <Text testID="delete-account-status" style={text}>
        Status: {request.status_label}
      </Text>
      {request.outcome_text ? <Text style={text}>{request.outcome_text}</Text> : null}
      {request.organization_decides ? <Text style={text}>{request.organization_decides}</Text> : null}
      {request.retained.length > 0 ? <Text style={text}>What we keep, and why:</Text> : null}
      {request.retained.map((r) => (
        <Text key={r.key} style={text}>
          • {r.label}. {r.why}
        </Text>
      ))}
      <Text style={text}>
        Keep the request ID. You can check it any time at {DELETE_ACCOUNT_URL.replace(/^https:\/\//, '')} or ask{' '}
        {ARAMO_SIGN_IDENTITY.privacyEmail}.
      </Text>
      <Button testID="delete-account-done" title={doneLabel} onPress={onDone} />
    </View>
  );
}
