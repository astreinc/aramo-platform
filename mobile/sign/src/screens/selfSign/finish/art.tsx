// M-A14 §1 items 5–8 — Aramo-drawn vector art and line icons for the post-Finish screens
// (R-8: Aramo colours only; no third-party artwork). Geometry follows the sign-mobile-v2
// prototype, which is Aramo's own design authority.
import Svg, { Circle, Defs, LinearGradient, Path, RadialGradient, Rect, Stop } from 'react-native-svg';

export const INK = '#0D1B4C';
export const SECONDARY = '#4A5578';
export const ACCENT = '#022AC0';
export const WHITE = '#FFFFFF';
/** The prototype's outlined-button border (Finish Signing, Done). */
export const OUTLINE = '#4A5578';
/** The Sign Next modal's "No thanks" border. */
export const OUTLINE_SOFT = '#8C90A0';
export const CARD_BORDER = '#DADCE3';
export const SUCCESS_TEXT = '#1E7A50';

/** "You're almost there": the paper plane (92×76). */
export function PaperPlane() {
  return (
    <Svg width={92} height={76} viewBox="0 0 92 76" accessible={false}>
      <Defs>
        <LinearGradient id="ma14-plane-a" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#7EA0FF" />
          <Stop offset="1" stopColor={ACCENT} />
        </LinearGradient>
        <LinearGradient id="ma14-plane-b" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#C9D6FF" />
          <Stop offset="1" stopColor="#5B7BF0" />
        </LinearGradient>
      </Defs>
      <Path d="M2 40 L90 2 L60 64 Z" fill="url(#ma14-plane-b)" />
      <Path d="M90 2 L32 48 L40 74 Z" fill="url(#ma14-plane-a)" />
      <Path d="M90 2 L32 48 L60 64 Z" fill="#3D63E6" opacity={0.55} />
    </Svg>
  );
}

/** "You've Signed": the green check, 74 across with a 3px pale ring (80×80 overall). */
export function SignedCheck() {
  return (
    <Svg width={80} height={80} viewBox="0 0 80 80" accessible={false}>
      <Defs>
        {/* 160deg: from upper-left-ish to lower-right-ish */}
        <LinearGradient id="ma14-check" x1="0.33" y1="0.03" x2="0.67" y2="0.97">
          <Stop offset="0" stopColor="#3FD49A" />
          <Stop offset="1" stopColor="#14895A" />
        </LinearGradient>
      </Defs>
      <Circle cx={40} cy={40} r={40} fill="#CFF3E3" />
      <Circle cx={40} cy={40} r={37} fill="url(#ma14-check)" />
      {/* 24-unit check scaled to 36px, centred */}
      <Path
        d="M20 6 9 17l-5-5"
        transform="translate(22 22) scale(1.5)"
        fill="none"
        stroke={WHITE}
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** The paper card's plant (56×72). */
export function Plant() {
  return (
    <Svg width={56} height={72} viewBox="0 0 56 72" accessible={false}>
      <Defs>
        <LinearGradient id="ma14-leaf" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#B9C8FF" />
          <Stop offset="1" stopColor="#3D63E6" />
        </LinearGradient>
      </Defs>
      <Rect x={25.5} y={18} width={5} height={54} rx={2} fill="#2E4FD0" />
      <Path d="M28 2c6 6 6 14 0 18-6-4-6-12 0-18z" fill="url(#ma14-leaf)" />
      <Path d="M28 34c-4-10-14-12-24-8 4 9 14 12 24 8z" fill="url(#ma14-leaf)" />
      <Path d="M28 34c4-10 14-12 24-8-4 9-14 12-24 8z" fill="url(#ma14-leaf)" />
      <Path d="M28 52c-4-10-14-12-24-8 4 9 14 12 24 8z" fill="url(#ma14-leaf)" />
      <Path d="M28 52c4-10 14-12 24-8-4 9-14 12-24 8z" fill="url(#ma14-leaf)" />
    </Svg>
  );
}

/**
 * Finishing… backdrop: a soft green glow at the top and a violet glow at the bottom right
 * over a grey wash. Drawn in a 100×100 box stretched to the screen so the ellipses keep
 * the prototype's percentage geometry.
 */
export function FinishingBackdrop() {
  return (
    <Svg
      width="100%"
      height="100%"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      accessible={false}
    >
      <Defs>
        <LinearGradient id="ma14-wash" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#E9ECEF" />
          <Stop offset="0.45" stopColor="#A9AAAD" />
          <Stop offset="0.7" stopColor="#B9BABD" />
          <Stop offset="1" stopColor="#E3E6EA" />
        </LinearGradient>
        <RadialGradient
          id="ma14-green"
          gradientUnits="userSpaceOnUse"
          cx={50}
          cy={14}
          rx={60}
          ry={18}
          fx={50}
          fy={14}
        >
          <Stop offset="0" stopColor="rgb(110,215,170)" stopOpacity={0.55} />
          <Stop offset="1" stopColor="rgb(110,215,170)" stopOpacity={0} />
        </RadialGradient>
        <RadialGradient
          id="ma14-violet"
          gradientUnits="userSpaceOnUse"
          cx={92}
          cy={98}
          rx={40}
          ry={30}
          fx={92}
          fy={98}
        >
          <Stop offset="0" stopColor="rgb(140,110,220)" stopOpacity={0.55} />
          <Stop offset="1" stopColor="rgb(140,110,220)" stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect x={0} y={0} width={100} height={100} fill="url(#ma14-wash)" />
      <Rect x={0} y={0} width={100} height={100} fill="url(#ma14-violet)" />
      <Rect x={0} y={0} width={100} height={100} fill="url(#ma14-green)" />
    </Svg>
  );
}

const ICONS = {
  mail: 'M4 6h16v12H4zM4 7l8 6 8-6',
  share: 'M12 15V4M8 8l4-4 4 4M5 13v7h14v-7',
  save: 'M12 4v11M8 11l4 4 4-4M5 20h14',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-5M12 8h.01',
} as const;

export type IconName = keyof typeof ICONS;

export function LineIcon({
  name,
  size = 22,
  color = WHITE,
  strokeWidth = 2.2,
}: {
  readonly name: IconName;
  readonly size?: number;
  readonly color?: string;
  readonly strokeWidth?: number;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" accessible={false}>
      <Path
        d={ICONS[name]}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
