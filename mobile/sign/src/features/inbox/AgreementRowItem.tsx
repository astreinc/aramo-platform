// One Agreements row (handoff §2A "Agreement row"; M-A4 §3.4): status icon, subject,
// status line and relative time, plus the iOS chevron. The row's swipe actions are also
// its VoiceOver / TalkBack custom actions (M-A4 §3.6).
import { StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { ListRow } from '../../components/ListRow';
import { useTheme } from '../../theme';
import {
  relativeTime,
  secondaryLine,
  statusIcon,
  type AgreementRow,
  type StatusIcon,
} from './agreementsModel';
import { rowA11yActions } from './SwipeActions';
import type { SwipeAction, SwipeActionKind } from './rowActionRules';

const ICON_PATH: Record<StatusIcon, string> = {
  needs: 'M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16zM14 6l4 4',
  waiting: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  draft: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6',
  completed: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM8 12.5l2.6 2.6L16 9.5',
  stopped: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM5.6 5.6l12.8 12.8',
  expired: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
};

export function AgreementStatusIcon({ icon }: { readonly icon: StatusIcon }) {
  const t = useTheme();
  const color =
    icon === 'needs'
      ? t.color.accent
      : icon === 'completed'
        ? t.color.success
        : icon === 'stopped'
          ? t.color.destructive
          : icon === 'expired'
            ? '#946011'
            : t.color.textSecondary;
  return (
    <View style={styles.icon} importantForAccessibility="no-hide-descendants">
      <Svg
        width={24}
        height={24}
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth={1.9}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <Path d={ICON_PATH[icon]} />
      </Svg>
    </View>
  );
}

export function AgreementRowItem({
  row,
  onPress,
  last,
  now,
  actions = [],
  onAction,
}: {
  readonly row: AgreementRow;
  readonly onPress: (row: AgreementRow) => void;
  readonly last?: boolean;
  readonly now?: number;
  /** The row's actions (swipeActionsFor), exposed to the screen reader as custom actions. */
  readonly actions?: readonly SwipeAction[];
  readonly onAction?: (row: AgreementRow, kind: SwipeActionKind) => void;
}) {
  const secondary = secondaryLine(row);
  const when = relativeTime(row.activityAt, now);
  const a11y =
    onAction && actions.length
      ? rowA11yActions(actions, row.subject, (k) => onAction(row, k))
      : undefined;
  return (
    <ListRow
      title={row.subject}
      leading={<AgreementStatusIcon icon={statusIcon(row)} />}
      subtitle={when ? `${secondary} · ${when}` : secondary}
      onPress={() => onPress(row)}
      showSeparator={!last}
      accessibilityLabel={`${row.subject}. ${secondary}. ${when}`}
      accessibilityActions={a11y?.accessibilityActions}
      onAccessibilityAction={a11y?.onAccessibilityAction}
    />
  );
}

const styles = StyleSheet.create({
  icon: { width: 28, alignItems: 'center', justifyContent: 'center' },
});
