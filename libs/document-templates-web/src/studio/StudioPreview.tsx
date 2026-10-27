import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Button, Checkbox } from '@aramo/fe-foundation';

import { Letterhead, SafeDoc, type LetterheadInfo } from '../dt-html-render';
import type { BindingMap } from '../dt-ui';
import { studioPlainText, studioPreviewParts } from '../studio-codec';

import type { StudioSamplePreview } from './data-source';
import { EmptyState } from './primitives';
import { fitZoom, paginate, zoomIn, zoomOut } from './pagination';
import { SignatureBlocksPreview } from './StudioRolesPanel';

// PLATFORM-UX-1 F-9 (handoff §10.7 Preview) — the paginated A4 preview. The draft
// preview is the server's sample render (POST …/versions/:id/preview); every page is
// drawn by SafeDoc, the shared safe allowlist renderer. Page breaks are estimated in the
// client (exact PDF pagination is a data gap, R-13). `:read` operators see the PUBLISHED
// version's content instead (draft preview needs :manage today — R-13).

export interface PreviewSource {
  readonly title: string;
  readonly html: string;
  /** sample = server sample values · content = stored content (variables as chips). */
  readonly mode: 'sample' | 'content';
  /** The footer version label ("Draft · v4", "v3"). */
  readonly version: string;
  readonly org: string;
}

export interface StudioPreviewProps {
  readonly source: PreviewSource | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly emptyLabel: string;
  readonly templateId: string;
  readonly map: BindingMap;
  readonly highlight: boolean;
  readonly onHighlight: (on: boolean) => void;
  readonly zoom: number;
  readonly onZoom: (z: number) => void;
  /** The editor's block heights, measured as Preview opened (null: estimate from text). */
  readonly blockHeights?: readonly number[] | null;
  /** TEMPLATE-STUDIO-1 S-1 — the letterhead logo drawn at the top of page 1 (organization; the render carries a logo). */
  readonly letterhead?: LetterheadInfo | null;
  /**
   * TEMPLATE-STUDIO-1 (scope ruling 2026-10-27 item 1) — organization context: while the
   * preview column is narrower than an A4 page, draw the pages at the zoom that fits the
   * column ("Fit"), so the page is never clipped. − / + leave Fit and step from the zoom on
   * screen; the Fit button returns to it. Absent / false (platform): the zoom is
   * `zoom` exactly, as before.
   */
  readonly fitToWidth?: boolean;
  /**
   * Amendment M-A6 §3.8 — the template's SIGNER roles: the last page ends with one
   * signature block per role, as Aramo Sign renders it. Empty / absent ⇒ unchanged.
   */
  readonly signatureRoles?: ReadonlyArray<{ readonly role_key: string; readonly label: string }>;
}

/** Horizontal padding of the `.pws-pv` region (24px each side, studio.css). */
const PV_PAD_X = 48;

/** The preview column's content width, tracked while `on` (0 until measured). */
function useAvailableWidth(ref: RefObject<HTMLDivElement | null>, on: boolean): number {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!on || el === null) return undefined;
    const measure = (): void => setW(Math.max(0, el.clientWidth - PV_PAD_X));
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, on]);
  return w;
}

/** The organization line of the page header: the preview's legal-name sample, if any. */
export function orgNameOf(p: StudioSamplePreview): string {
  const s = p.sample_values ?? [];
  const hit = s.find((x) => /(^|\.)legal_name$/.test(x.key)) ?? s.find((x) => /^(organization|recruiting_company)\.name$/.test(x.key));
  return hit?.value ?? '';
}

export function StudioPreview(props: StudioPreviewProps) {
  const { source } = props;
  const parts = source !== null ? studioPreviewParts(source.html) : [];
  // Stored content (the :read view) estimates with each variable as its {{key}} token, as
  // the design does; a sample render estimates with the sample values.
  const pages = paginate(
    parts.map((p) => (source?.mode === 'content' ? studioPlainText(p.html) : p.text)),
    props.blockHeights,
  );
  const count = source !== null ? pages.length : 0;
  const fitOn = props.fitToWidth === true;
  const regionRef = useRef<HTMLDivElement | null>(null);
  const avail = useAvailableWidth(regionRef, fitOn);
  const [fit, setFit] = useState(true);
  const fitting = fitOn && fit;
  const zoom = fitting ? fitZoom(avail) : props.zoom;
  const step = (z: number): void => {
    setFit(false);
    props.onZoom(z);
  };
  return (
    <>
      <div className="pws-pvbar">
        <span className="pws-pvbar__t">Preview</span>
        <div role="group" aria-label="Sample data" className="pws-seg pws-seg--sm">
          <Button unstyled aria-pressed className="pws-seg__item pws-seg__item--on">
            Standard samples
          </Button>
          <Button unstyled aria-pressed={false} disabled className="pws-seg__item" title="Long sample values aren't available from the server yet">
            Long values
          </Button>
        </div>
        <label className="pws-pvbar__hl">
          <Checkbox unstyled className="pws-check-in" checked={props.highlight} onChange={(e) => props.onHighlight(e.target.checked)} />
          Highlight variables
        </label>
        <span className="pws-pvbar__count">
          {`${count} ${count === 1 ? 'page' : 'pages'}`} · A4
        </span>
        <span className="pws-pvbar__zoom">
          {fitOn ? (
            <Button
              unstyled
              className={`pws-zbtn pws-zbtn--fit${fitting ? ' pws-zbtn--on' : ''}`}
              aria-label="Fit to width"
              aria-pressed={fitting}
              title="Fit the page to the preview width"
              onClick={() => setFit(true)}
            >
              Fit
            </Button>
          ) : null}
          <Button unstyled className="pws-zbtn" aria-label="Zoom out" onClick={() => step(zoomOut(zoom))}>
            −
          </Button>
          <span className="pws-pvbar__z" aria-live="polite">
            {`${zoom}%`}
          </span>
          <Button unstyled className="pws-zbtn" aria-label="Zoom in" onClick={() => step(zoomIn(zoom))}>
            +
          </Button>
        </span>
      </div>
      {/* Keyboard-scrollable (WCAG 2.1.1): the pages scroll in this region. */}
      <div ref={regionRef} className="pws-pv" tabIndex={0} role="region" aria-label="Preview pages">
        {props.error !== null ? (
          <div role="alert" className="ts-alert ts-alert--error pws-pv__err">
            {props.error}
          </div>
        ) : null}
        {props.loading ? (
          <div className="pws-pv__status" role="status">
            Preparing the preview…
          </div>
        ) : source === null ? (
          props.error === null ? (
            <div className="pws-pv__empty">
              <EmptyState title="Nothing to preview" body={props.emptyLabel} />
            </div>
          ) : null
        ) : (
          <div className={`pws-pv__pages${props.highlight ? ' pws-pv__pages--hl' : ''}`} style={{ zoom: zoom / 100 }}>
            {pages.map((pg, i) => (
              <article key={i} aria-label={`Page ${i + 1}`} className="pws-pvpage">
                <div className="pws-pvpage__head">
                  <span className="pws-pvpage__org">{source.org}</span>
                  <span>{source.title}</span>
                </div>
                {i === 0 && props.letterhead != null ? <Letterhead info={props.letterhead} variant="rendered" testId="studio-preview-letterhead" /> : null}
                {i === 0 ? <h1 className="pws-pvpage__h1">{source.title}</h1> : null}
                <div className="pws-pvpage__body">
                  <SafeDoc html={pg.map((k) => parts[k]?.html ?? '').join('')} map={props.map} mode={source.mode} letterhead={null} />
                  {i === pages.length - 1 && (props.signatureRoles?.length ?? 0) > 0 ? <SignatureBlocksPreview roles={props.signatureRoles ?? []} /> : null}
                </div>
                <div className="pws-pvpage__foot">
                  <span className="pws-mono">
                    {props.templateId} · {source.version}
                  </span>
                  <span>
                    Page {i + 1} of {pages.length}
                  </span>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
