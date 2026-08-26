import { useEffect, useRef } from 'react';

// COMM-B4 — the Zoom-specific browser boundary. ALL Zoom vocabulary and browser
// behaviour is confined to THIS file (directive §33) — never in Talent
// components. B4 does NOT add a real Zoom SDK/package/script dependency: the real
// Smart Embed load (which needs the Zoom Desktop client + an admin-installed
// embed + a domain allowlist, §54) is COMM-B8 and is NOT CI-testable. B4 ships an
// INJECTABLE loader boundary; the default is an inert stub, and tests inject a
// mock loader to assert the boundary is exercised.

/** Loads/attaches the Zoom Smart Embed into a container. Injected; real impl = B8. */
export interface ZoomEmbedLoader {
  attach(container: HTMLElement): void | Promise<void>;
}

/** Inert default — renders the placeholder only; no real Zoom Smart Embed load (B8). */
export const stubZoomEmbedLoader: ZoomEmbedLoader = {
  attach(): void {
    /* no-op — the real Zoom Smart Embed load lands in COMM-B8 */
  },
};

export interface ZoomPhoneEmbedProps {
  readonly loader?: ZoomEmbedLoader;
}

export function ZoomPhoneEmbed({ loader = stubZoomEmbedLoader }: ZoomPhoneEmbedProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (el !== null) {
      void loader.attach(el);
    }
  }, [loader]);

  return (
    <div
      ref={containerRef}
      className="rc-comm-embed"
      role="region"
      aria-label="Zoom Phone"
      data-testid="zoom-phone-embed"
    >
      <p className="rc-comm-embed__placeholder">
        The Zoom Phone dialer opens in your Zoom app when calling begins.
      </p>
    </div>
  );
}
