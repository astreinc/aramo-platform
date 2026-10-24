import type { CSSProperties } from 'react';

import './platform-components.css';

// PLATFORM-UX-1 F-1 — skeletons (handoff §3.6): static #EEF1F4 blocks sized to
// the final content, one set per panel. No shimmer (reduced-motion friendly).

export interface SkeletonProps {
  /** CSS width (px number or any CSS length). Default: 100%. */
  readonly width?: number | string;
  /** Height in px. Default: 14. */
  readonly height?: number;
  /** Corner radius in px. Default: 4. */
  readonly radius?: number;
}

export function Skeleton({ width = '100%', height = 14, radius = 4 }: SkeletonProps) {
  const style: CSSProperties = { width, height, borderRadius: radius };
  return <span className="pw-skeleton" style={style} aria-hidden="true" />;
}

export interface SkeletonPanelProps {
  /** One width per line (CSS lengths). Default: the design's 3-line panel. */
  readonly lines?: readonly (number | string)[];
  /** Screen-reader status text. Default: "Loading…". */
  readonly label?: string;
}

/** A panel's loading block: 16px 20px padding, 12px gap, 14px lines. */
export function SkeletonPanel({ lines = ['100%', '80%', '90%'], label = 'Loading…' }: SkeletonPanelProps) {
  return (
    <div className="pw-skeleton-panel" aria-busy="true">
      <span className="pw-sr-only" role="status">
        {label}
      </span>
      {lines.map((w, i) => (
        <Skeleton key={i} width={w} />
      ))}
    </div>
  );
}
