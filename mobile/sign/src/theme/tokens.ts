// Platform tokens — values ported verbatim from the design handoff §3 (and §4.1, §4.10,
// §5 where they define colours/sizes). Aramo blue #022AC0 is shared with web.

export const ACCENT = '#022AC0';

export interface PlatformTheme {
  readonly platform: 'ios' | 'android';
  readonly font: { readonly family: string | undefined };
  readonly color: {
    readonly screen: string;
    readonly surface: string;
    readonly surfaceBorder: string | null;
    readonly text: string;
    readonly textSecondary: string;
    readonly textTertiary: string;
    readonly separator: string;
    readonly accent: string;
    readonly tint: string;
    readonly onTint: string;
    readonly fill: string;
    readonly documentBackdrop: string;
    readonly sheet: string;
    readonly grabber: string;
    readonly destructive: string;
    readonly destructiveTint: string;
    readonly success: string;
    readonly successTint: string;
    readonly signInBorder: string;
    readonly badge: string;
    readonly white: string;
  };
  readonly size: {
    readonly separatorWidth: number;
    readonly cardRadius: number;
    readonly sheetTopRadius: number;
    readonly grabber: { readonly width: number; readonly height: number };
    readonly pillRadius: number;
    readonly minTouch: number;
    readonly appTileRadius: number;
  };
  readonly button: {
    readonly primary: {
      readonly height: number;
      readonly radius: number;
      readonly fontSize: number;
      readonly fontWeight: '500' | '600';
    };
    readonly signIn: {
      readonly height: number;
      readonly radius: number;
      readonly fontSize: number;
      readonly fontWeight: '500' | '600';
    };
    readonly secondary: 'tinted' | 'outlined';
    readonly outline: string;
  };
  readonly type: {
    readonly appTitle: { readonly fontSize: number; readonly fontWeight: '400' | '700' };
    readonly largeTitle: { readonly fontSize: number; readonly fontWeight: '400' | '700' };
    readonly detailTitle: { readonly fontSize: number; readonly fontWeight: '400' | '700' };
    readonly rowTitle: { readonly fontSize: number; readonly fontWeight: '400' | '600' };
  };
  readonly toast: {
    readonly background: string;
    readonly radius: number;
    readonly bottomOffset: number;
  };
}

export const iosTheme: PlatformTheme = {
  platform: 'ios',
  font: { family: undefined }, // System (SF Pro)
  color: {
    screen: '#F2F2F7',
    surface: '#FFFFFF',
    surfaceBorder: null,
    text: '#000000',
    textSecondary: 'rgba(60,60,67,0.62)',
    textTertiary: 'rgba(60,60,67,0.34)',
    separator: 'rgba(60,60,67,0.16)',
    accent: ACCENT,
    tint: '#E8EDFB',
    onTint: '#011F8D',
    fill: 'rgba(118,118,128,0.12)',
    documentBackdrop: '#E5E5EA',
    sheet: '#F2F2F7',
    grabber: 'rgba(60,60,67,0.30)',
    destructive: '#D70015',
    destructiveTint: '#FFE9E7',
    success: '#1F7A4D',
    successTint: '#E6F2EA',
    signInBorder: '#D1D1D6',
    badge: '#FF3B30',
    white: '#FFFFFF',
  },
  size: {
    separatorWidth: 0.5,
    cardRadius: 12,
    sheetTopRadius: 14,
    grabber: { width: 36, height: 5 },
    pillRadius: 6,
    minTouch: 44,
    appTileRadius: 20,
  },
  button: {
    primary: { height: 50, radius: 14, fontSize: 17, fontWeight: '600' },
    signIn: { height: 52, radius: 14, fontSize: 17, fontWeight: '600' },
    secondary: 'tinted',
    outline: '#767680',
  },
  type: {
    appTitle: { fontSize: 30, fontWeight: '700' },
    largeTitle: { fontSize: 34, fontWeight: '700' },
    detailTitle: { fontSize: 24, fontWeight: '700' },
    rowTitle: { fontSize: 15.5, fontWeight: '600' },
  },
  toast: { background: 'rgba(30,30,32,0.92)', radius: 20, bottomOffset: 110 },
};

export const androidTheme: PlatformTheme = {
  platform: 'android',
  font: { family: 'Roboto' },
  color: {
    screen: '#FBF8FF',
    surface: '#FFFFFF',
    surfaceBorder: '#E2E1EC',
    text: '#1B1B21',
    textSecondary: '#46464F',
    textTertiary: '#767680',
    separator: '#E2E1EC',
    accent: ACCENT,
    tint: '#DDE1FF',
    onTint: '#00164E',
    fill: '#EFEDF4',
    documentBackdrop: '#E4E2EC',
    sheet: '#F4F2FA',
    grabber: '#79747E',
    destructive: '#B3261E',
    destructiveTint: '#F9DEDC', // not in the handoff: Material 3 error container
    success: '#1F7A4D',
    successTint: '#E6F2EA',
    signInBorder: '#767680',
    badge: '#B3261E',
    white: '#FFFFFF',
  },
  size: {
    separatorWidth: 1,
    cardRadius: 16,
    sheetTopRadius: 28,
    grabber: { width: 32, height: 4 },
    pillRadius: 8,
    minTouch: 48,
    appTileRadius: 28,
  },
  button: {
    primary: { height: 48, radius: 24, fontSize: 15, fontWeight: '500' },
    signIn: { height: 48, radius: 24, fontSize: 15, fontWeight: '500' },
    secondary: 'outlined',
    outline: '#767680',
  },
  type: {
    appTitle: { fontSize: 32, fontWeight: '400' },
    largeTitle: { fontSize: 22, fontWeight: '400' },
    detailTitle: { fontSize: 26, fontWeight: '400' },
    rowTitle: { fontSize: 16, fontWeight: '400' },
  },
  toast: { background: '#313036', radius: 4, bottomOffset: 96 },
};

/** Envelope status pills (handoff §3), shared by both platforms. */
export const STATUS_PILL = {
  DRAFT: { bg: '#EEF1F4', fg: '#5C6770', label: 'Draft' },
  SENT: { bg: '#E8EDFB', fg: '#011F8D', label: 'Sent' },
  IN_PROGRESS: { bg: '#E8EDFB', fg: '#011F8D', label: 'In progress' },
  COMPLETED: { bg: '#E6F2EA', fg: '#1F7A4D', label: 'Completed' },
  DECLINED: { bg: '#FBE9E7', fg: '#B3402A', label: 'Declined' },
  VOIDED: { bg: '#EEF1F4', fg: '#5C6770', label: 'Voided' },
  EXPIRED: { bg: '#FAEFD8', fg: '#946011', label: 'Expired' },
  NEEDS_ME: { bg: ACCENT, fg: '#FFFFFF', label: 'Sign now' },
} as const;

export type PillStatus = keyof typeof STATUS_PILL;

/** Recipient colours in order; they repeat after four (handoff §3). */
export const RECIPIENT_COLORS = ['#022AC0', '#0E7C66', '#B45309', '#7A3B52'] as const;

export function recipientColor(index: number): string {
  return (
    RECIPIENT_COLORS[
      ((index % RECIPIENT_COLORS.length) + RECIPIENT_COLORS.length) % RECIPIENT_COLORS.length
    ] ?? ACCENT
  );
}

/** Personal limit banner (handoff §4.10) and offline/disabled opacity (§3). */
export const BANNER = { limit: { bg: '#FFF4E0', fg: '#5C3B00' } } as const;
export const DISABLED_OPACITY = 0.42;
export const TOAST_DURATION_MS = 2600;
/** Signature ink (handoff §4.4 Draw). */
export const SIGNATURE_INK = '#0B1F6B';
