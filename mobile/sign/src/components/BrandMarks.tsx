// The aramo mark (white on the accent tile) and the official provider logos used on the
// sign-in buttons (handoff §4.1), transcribed from the prototype SVG.
import Svg, { Circle, G, Line, Path, Rect } from 'react-native-svg';

export function AramoMark({ size = 52 }: { readonly size?: number }) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <G stroke="#FFFFFF" strokeWidth={5} strokeLinecap="round">
        <Line x1={43} y1={32} x2={56} y2={32} />
        <Line x1={32} y1={43} x2={32} y2={56} />
        <Line x1={24.2} y1={39.8} x2={15} y2={49} />
        <Line x1={21} y1={32} x2={8} y2={32} />
        <Line x1={24.2} y1={24.2} x2={15} y2={15} />
        <Line x1={32} y1={21} x2={32} y2={8} />
        <Line x1={39.8} y1={39.8} x2={49} y2={49} />
      </G>
      <Line
        x1={39.8}
        y1={24.2}
        x2={54.5}
        y2={9.5}
        stroke="#D97757"
        strokeWidth={6}
        strokeLinecap="round"
      />
      <Circle cx={32} cy={32} r={6} fill="#FFFFFF" />
    </Svg>
  );
}

export function MicrosoftLogo({ size = 18 }: { readonly size?: number }) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 21 21"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Rect x={1} y={1} width={9} height={9} fill="#F25022" />
      <Rect x={11} y={1} width={9} height={9} fill="#7FBA00" />
      <Rect x={1} y={11} width={9} height={9} fill="#00A4EF" />
      <Rect x={11} y={11} width={9} height={9} fill="#FFB900" />
    </Svg>
  );
}

export function GoogleLogo({ size = 18 }: { readonly size?: number }) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <Path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <Path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <Path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </Svg>
  );
}

/**
 * The Apple logo for "Sign in with Apple" / "Continue with Apple" (Apple Go-Live W3/W4):
 * Apple's button rules allow only a black or white button with the logo in the opposite
 * color, so the color is a prop (white on the black sign-in button).
 */
export function AppleLogo({
  size = 18,
  color = '#000000',
}: {
  readonly size?: number;
  readonly color?: string;
}) {
  return (
    <Svg
      width={(size * 814) / 1000}
      height={size}
      viewBox="0 0 814 1000"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Path
        fill={color}
        d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76.5 0-103.7 40.8-165.9 40.8s-105.6-57-155.5-127C46.7 790.7 0 663 0 541.8c0-194.4 126.4-297.5 250.8-297.5 66.1 0 121.2 43.4 162.7 43.4 39.5 0 101.1-46 176.3-46 28.5 0 130.9 2.6 198.3 99.2zm-234-181.5c31.1-36.9 53.1-88.1 53.1-139.3 0-7.1-.6-14.3-1.9-20.1-50.6 1.9-110.8 33.7-147.1 75.8-28.5 32.4-55.1 83.6-55.1 135.5 0 7.8 1.3 15.6 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 45.4 0 102.5-30.4 135.5-71.3z"
      />
    </Svg>
  );
}

/** The provider's logo at `size` (Apple in black unless told otherwise). */
export function ProviderLogo({
  provider,
  size = 18,
  appleColor,
}: {
  readonly provider: 'google' | 'microsoft' | 'apple';
  readonly size?: number;
  readonly appleColor?: string;
}) {
  if (provider === 'microsoft') return <MicrosoftLogo size={size} />;
  if (provider === 'apple')
    return <AppleLogo size={size} {...(appleColor ? { color: appleColor } : {})} />;
  return <GoogleLogo size={size} />;
}
