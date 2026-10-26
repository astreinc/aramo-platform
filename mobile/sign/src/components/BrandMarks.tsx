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
