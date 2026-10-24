import { Button, Checkbox } from '@aramo/fe-foundation';
import { SafeDoc, studioPreviewParts, type BindingMap } from '@aramo/document-templates-web';

import { EmptyState } from '../../components/EmptyState';
import type { SamplePreview } from '../document-templates-api';

import { paginate, zoomIn, zoomOut } from './pagination';

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
}

/** The organization line of the page header: the preview's legal-name sample, if any. */
export function orgNameOf(p: SamplePreview): string {
  const s = p.sample_values ?? [];
  const hit = s.find((x) => /(^|\.)legal_name$/.test(x.key)) ?? s.find((x) => /^(organization|recruiting_company)\.name$/.test(x.key));
  return hit?.value ?? '';
}

export function StudioPreview(props: StudioPreviewProps) {
  const { source } = props;
  const parts = source !== null ? studioPreviewParts(source.html) : [];
  const pages = paginate(parts.map((p) => p.text));
  const count = source !== null ? pages.length : 0;
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
          {count} {count === 1 ? 'page' : 'pages'} · A4
        </span>
        <span className="pws-pvbar__zoom">
          <Button unstyled className="pws-zbtn" aria-label="Zoom out" onClick={() => props.onZoom(zoomOut(props.zoom))}>
            −
          </Button>
          <span className="pws-pvbar__z" aria-live="polite">
            {props.zoom}%
          </span>
          <Button unstyled className="pws-zbtn" aria-label="Zoom in" onClick={() => props.onZoom(zoomIn(props.zoom))}>
            +
          </Button>
        </span>
      </div>
      <div className="pws-pv">
        {props.error !== null ? (
          <div role="alert" className="pw-alert pw-alert--error pws-pv__err">
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
          <div className={`pws-pv__pages${props.highlight ? ' pws-pv__pages--hl' : ''}`} style={{ zoom: props.zoom / 100 }}>
            {pages.map((pg, i) => (
              <article key={i} aria-label={`Page ${i + 1}`} className="pws-pvpage">
                <div className="pws-pvpage__head">
                  <span className="pws-pvpage__org">{source.org}</span>
                  <span>{source.title}</span>
                </div>
                {i === 0 ? <h1 className="pws-pvpage__h1">{source.title}</h1> : null}
                <div className="pws-pvpage__body">
                  <SafeDoc html={pg.map((k) => parts[k]?.html ?? '').join('')} map={props.map} mode={source.mode} letterhead={null} />
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
