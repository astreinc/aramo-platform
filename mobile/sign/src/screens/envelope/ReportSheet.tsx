// Amendment M-A7 §5.2 (R-11) — "Report this envelope" from the received-envelope
// view: pick a reason; the report goes to the same flow as "Report this email".
import { Text } from 'react-native';

import { Button } from '../../components/Button';
import { Sheet } from '../../components/Sheet';
import { REPORT_REASONS, type ReportReasonKey } from '../../features/inbox/inboxReport';
import { useTheme } from '../../theme';

export function ReportSheet({
  visible,
  busy,
  onReport,
  onClose,
}: {
  readonly visible: boolean;
  readonly busy: boolean;
  readonly onReport: (reason: ReportReasonKey) => void;
  readonly onClose: () => void;
}) {
  const t = useTheme();
  return (
    <Sheet visible={visible} onClose={onClose} title="Report this envelope">
      <Text style={{ color: t.color.textSecondary, fontSize: 15, lineHeight: 21, fontFamily: t.font.family }}>
        What’s wrong with it? Aramo reviews every report. Don’t open links or sign documents you don’t trust.
      </Text>
      {REPORT_REASONS.map((r) => (
        <Button
          key={r.key}
          testID={`report-reason-${r.key}`}
          title={r.label}
          variant="secondary"
          accessibilityHint={r.sub}
          disabled={busy}
          onPress={() => onReport(r.key)}
        />
      ))}
      <Button title="Cancel" variant="text" onPress={onClose} disabled={busy} />
    </Sheet>
  );
}
