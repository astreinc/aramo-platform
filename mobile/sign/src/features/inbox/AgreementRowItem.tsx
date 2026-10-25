// One Agreements row (handoff §4.2 "Row"): toned 40 dp tile, subject, pill + secondary
// line, relative time, iOS chevron.
import { ListRow, RowTile } from '../../components/ListRow';
import { StatusPill } from '../../components/StatusPill';
import { STATUS_PILL, useTheme } from '../../theme';
import {
  pillFor,
  relativeTime,
  secondaryLine,
  tileTone,
  type AgreementRow,
} from './agreementsModel';

export function AgreementRowItem({
  row,
  onPress,
  last,
  now,
}: {
  readonly row: AgreementRow;
  readonly onPress: (row: AgreementRow) => void;
  readonly last?: boolean;
  readonly now?: number;
}) {
  const t = useTheme();
  const tone = tileTone(row);
  const tile =
    tone === 'needs'
      ? { bg: t.color.tint, fg: t.color.accent }
      : tone === 'completed'
        ? { bg: t.color.successTint, fg: t.color.success }
        : tone === 'declined'
          ? { bg: '#FBE9E7', fg: '#B3402A' }
          : { bg: t.color.fill, fg: t.color.textSecondary };
  const pill = pillFor(row);
  const secondary = secondaryLine(row);
  const when = relativeTime(row.activityAt, now);
  return (
    <ListRow
      title={row.subject}
      leading={<RowTile background={tile.bg} color={tile.fg} />}
      accessory={<StatusPill status={pill} />}
      subtitle={secondary}
      trailing={when}
      onPress={() => onPress(row)}
      showSeparator={!last}
      accessibilityLabel={`${row.subject}. ${STATUS_PILL[pill].label}. ${secondary}. ${when}`}
    />
  );
}
