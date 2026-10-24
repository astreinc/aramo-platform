import { Button } from '@aramo/fe-foundation';
import { studioPlainText, type StudioBlock } from '@aramo/document-templates-web';

import { EmptyState } from '../../components/EmptyState';
import { Pill, type PillSpec } from '../../components/Pill';

import { KIND_LABEL } from './StudioBlockEditable';
import type { StudioDrag } from './use-studio-drag';

// PLATFORM-UX-1 F-9 (handoff §10.5) — the left panel: Outline · Sections · Versions.
// Sections is the designed EMPTY state (directive R-13: no section-library storage).

export type LeftTab = 'outline' | 'sections' | 'versions';

export interface VersionRowModel {
  /** 'draft' or the version id. */
  readonly key: string;
  readonly n: string;
  readonly pill: PillSpec;
  readonly sub: string;
  readonly on: boolean;
}

export interface StudioLeftPanelProps {
  readonly tab: LeftTab;
  readonly onTab: (t: LeftTab) => void;
  readonly blocks: readonly StudioBlock[];
  readonly headings: number;
  readonly variables: number;
  readonly selectedId: string | null;
  readonly editable: boolean;
  readonly onGo: (id: string) => void;
  readonly drag: StudioDrag;
  readonly versions: readonly VersionRowModel[];
  readonly onView: (key: string) => void;
  readonly onCompare: (key: string) => void;
  readonly overlay: boolean;
}

const TABS: ReadonlyArray<[LeftTab, string]> = [
  ['outline', 'Outline'],
  ['sections', 'Sections'],
  ['versions', 'Versions'],
];

function outlineLabel(b: StudioBlock): string {
  const t = studioPlainText(b.value);
  if (t === '') return `Empty ${KIND_LABEL[b.kind].toLowerCase()}`;
  return t.length > 46 ? `${t.slice(0, 46)}…` : t;
}

export function StudioLeftPanel(props: StudioLeftPanelProps) {
  const { tab, blocks, selectedId, drag } = props;
  let inHeading = false;
  return (
    <aside aria-label="Template structure" className={`pws-left${props.overlay ? ' pws-left--overlay' : ''}`}>
      <div className="pws-panel-tabs">
        <div role="tablist" aria-label="Structure" className="pws-seg pws-seg--fill">
          {TABS.map(([k, l]) => (
            <Button key={k} unstyled role="tab" aria-selected={tab === k} className={`pws-seg__item${tab === k ? ' pws-seg__item--on' : ''}`} onClick={() => props.onTab(k)}>
              {l}
            </Button>
          ))}
        </div>
      </div>
      <div className="pws-left__body" role="tabpanel">
        {tab === 'outline' ? (
          <>
            <div className="pws-outline__stats">
              {`${props.headings} headings · ${blocks.length} blocks · ${props.variables} variables`}
            </div>
            {blocks.map((b, i) => {
              const isH = b.kind === 'h2';
              if (isH) inHeading = true;
              const on = b.id === selectedId;
              const d = drag.dropAt;
              return (
                <div key={b.id} className="pws-orow" onDragOver={(e) => drag.over(e, b.id)} onDrop={(e) => drag.drop(e, b.id)}>
                  {d !== null && d.id === b.id && d.pos === 'before' ? <div className="pws-orow__drop pws-orow__drop--before" aria-hidden="true" /> : null}
                  <Button
                    unstyled
                    draggable={props.editable}
                    title={KIND_LABEL[b.kind]}
                    className={`pws-orow__btn${isH ? ' pws-orow__btn--h' : inHeading ? ' pws-orow__btn--in' : ''}${on ? ' pws-orow__btn--on' : ''}`}
                    onDragStart={(e) => drag.start(e, { kind: 'block', id: b.id })}
                    onDragEnd={drag.end}
                    onClick={() => props.onGo(b.id)}
                  >
                    <span className="pws-orow__n">{i + 1}</span>
                    <span className="pws-orow__l">{outlineLabel(b)}</span>
                  </Button>
                  {d !== null && d.id === b.id && d.pos === 'after' ? <div className="pws-orow__drop pws-orow__drop--after" aria-hidden="true" /> : null}
                </div>
              );
            })}
            {blocks.length === 0 ? <div className="pws-outline__empty">The outline fills in as you add headings and paragraphs.</div> : null}
            <div className="pws-outline__foot">Drag rows to reorder blocks.</div>
          </>
        ) : null}
        {tab === 'sections' ? (
          <EmptyState title="No sections yet" body="Reusable sections appear here once a shared section library is available. Inserted content becomes part of this draft." />
        ) : null}
        {tab === 'versions' ? (
          <>
            {props.versions.map((v) => (
              <div key={v.key} className={`pws-vrow${v.on ? ' pws-vrow--on' : ''}`}>
                <Button unstyled className="pws-vrow__view" onClick={() => props.onView(v.key)}>
                  <span className="pws-vrow__top">
                    <b className="pws-vrow__n">{v.n}</b>
                    <span className="pws-pill20">
                      <Pill tone={v.pill.tone} dot={false}>
                        {v.pill.label}
                      </Pill>
                    </span>
                  </span>
                  <span className="pws-vrow__sub">{v.sub}</span>
                </Button>
                <Button unstyled className="pws-btn26" title="Compare with draft" onClick={() => props.onCompare(v.key)}>
                  Diff
                </Button>
              </div>
            ))}
          </>
        ) : null}
      </div>
    </aside>
  );
}
