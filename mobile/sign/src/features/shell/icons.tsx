// Stroke icons for the shell, path data copied from the prototype (Aramo Sign Mobile.dc.html).
import Svg, { Path } from 'react-native-svg';

export const SHELL_ICON = {
  menu: 'M4 7h16M4 12h16M4 17h16',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-3.5-3.5',
  needs: 'M4 7l2 2 3-3M4 15l2 2 3-3M12 7h8M12 15h8',
  close: 'M18 6 6 18M6 6l12 12',
  plus: 'M12 5v14M5 12h14',
  chevronRight: 'M9 6l6 6-6 6',
  chevronLeft: 'M15 6l-6 6 6 6',
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  agreements: 'M3 13h5l1.5 3h5L16 13h5M5 5h14l2 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z',
  account: 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  templates: 'M4 4h16v16H4zM4 9h16M9 9v11',
  notifications: 'M18 16v-5a6 6 0 1 0-12 0v5l-2 2h16zM10 21h4',
  settings:
    'M12 8.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1',
  logout: 'M12 3v8M6.3 6.3a8 8 0 1 0 11.4 0',
  request:
    'M16 19a4 4 0 0 0-8 0M12 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 19a3.5 3.5 0 0 0-3-3.4M17 5.2a3 3 0 0 1 0 5.6',
  selfSign: 'M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16zM14 6l4 4',
} as const;

export type ShellIconName = keyof typeof SHELL_ICON;

export function ShellIcon({
  name,
  size = 24,
  color,
  strokeWidth = 2,
}: {
  readonly name: ShellIconName;
  readonly size?: number;
  readonly color: string;
  readonly strokeWidth?: number;
}) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Path d={SHELL_ICON[name]} />
    </Svg>
  );
}
