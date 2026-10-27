import { Button } from '@aramo/fe-foundation';

import { studioReadableText, type StudioBlock } from '../studio-codec';

import { EmptyState, Pill, type PillSpec } from './primitives';
import { KIND_LABEL } from './StudioBlockEditable';
import type { StudioDrag } from './use-studio-drag';
import type { VariableCatalog } from './variables';

// PLATFORM-UX-1 F-9 (handoff §10.5) — the left panel: Outline · Sections · Versions.
// Sections is the designed EMPTY state (directive R-13: no section-library storage).
// TEMPLATE-STUDIO-1 S-1 (directive §7.2) — the organization context lists its static
// section set instead (Insert only; no usage counts, no shared store). S-2 — the tenant
// preview of an Aramo default has no Versions tab (ADR-0034 D3).

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
  /** The Studio's loaded variable catalog — Outline rows show variable labels. */
  readonly catalog: Pick<VariableCatalog, 'byKey'>;
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
  /** TEMPLATE-STUDIO-1 — the static section set (absent: the empty state). */
  readonly sections?: readonly SectionCardModel[];
  readonly onInsertSection?: (key: string) => void;
  /** Show the Versions tab (default true). */
  readonly showVersions?: boolean;
}

export interface SectionCardModel {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly variables: number;
  /** Every variable it uses is bindable for this template. */
  readonly insertable: boolean;
}

const TABS: ReadonlyArray<[LeftTab, string]> = [
  ['outline', 'Outline'],
  ['sections', 'Sections'],
  ['versions', 'Versions'],
];

const OUTLINE_MAX = 46;

/**
 * TEMPLATE-STUDIO-1 (handoff §3 "Labels are readable text") — an Outline row's label.
 * Variables read as their catalog label (the Studio's already-loaded governed catalog:
 * platform template-variables, org allowed-bindings, gallery preview samples — never a
 * second label map); image variables get "▣ "; a key the catalog does not carry reads as
 * the bare key (no braces). Stray spaces before `, . )` (and the chip padding after `(`)
 * are removed; long labels truncate at 46 characters with "…"; an empty block reads
 * "Empty <kind>" ("Empty paragraph"). PRESENTATION ONLY — the block value is never touched.
 */
export function outlineLabel(b: StudioBlock, catalog: Pick<VariableCatalog, 'byKey'>): string {
  const t = studioReadableText(b.value, (key) => {
    const v = catalog.byKey.get(key);
    if (v === undefined) return ` ${key} `;
    return ` ${v.type === 'image' ? '▣ ' : ''}${v.label} `;
  })
    .replace(/\s+([,.)])/g, '$1')
    .replace(/\(\s+/g, '(');
  if (t === '') return `Empty ${KIND_LABEL[b.kind].toLowerCase()}`;
  return t.length > OUTLINE_MAX ? `${t.slice(0, OUTLINE_MAX)}…` : t;
}

export function StudioLeftPanel(props: StudioLeftPanelProps) {
  const { tab, blocks, selectedId, drag } = props;
  let inHeading = false;
  return (
    <aside aria-label="Template structure" className={`pws-left${props.overlay ? ' pws-left--overlay' : ''}`}>
      <div className="pws-panel-tabs">
        <div role="tablist" aria-label="Structure" className="pws-seg pws-seg--fill">
          {TABS.filter(([k]) => k !== 'versions' || props.showVersions !== false).map(([k, l]) => (
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
                    <span className="pws-orow__l">{outlineLabel(b, props.catalog)}</span>
                  </Button>
                  {d !== null && d.id === b.id && d.pos === 'after' ? <div className="pws-orow__drop pws-orow__drop--after" aria-hidden="true" /> : null}
                </div>
              );
            })}
            {blocks.length === 0 ? <div className="pws-outline__empty">The outline fills in as you add headings and paragraphs.</div> : null}
            <div className="pws-outline__foot">Drag rows to reorder blocks.</div>
          </>
        ) : null}
        {tab === 'sections' && props.sections === undefined ? (
          <EmptyState title="No sections yet" body="Reusable sections appear here once a shared section library is available. Inserted content becomes part of this draft." />
        ) : null}
        {tab === 'sections' && props.sections !== undefined ? (
          <div className="pws-secs">
            <p className="pws-secs__intro">Click Insert to add a section after the selected block. Inserted content becomes part of this draft.</p>
            {props.sections.map((s) => (
              <div key={s.key} className="pws-sec" data-testid={`studio-section-${s.key}`}>
                <span className="pws-sec__name">{s.name}</span>
                {props.editable ? (
                  <Button
                    unstyled
                    className="pws-btn26 pws-sec__ins"
                    disabled={!s.insertable}
                    title={s.insertable ? 'Insert after the selected block' : 'Uses a variable this document type can’t bind'}
                    aria-label={`Insert ${s.name}`}
                    onClick={() => props.onInsertSection?.(s.key)}
                  >
                    Insert
                  </Button>
                ) : null}
                <span className="pws-sec__desc">{s.description}</span>
                <span className="pws-sec__meta">{`${s.variables} ${s.variables === 1 ? 'variable' : 'variables'}`}</span>
              </div>
            ))}
          </div>
        ) : null}
        {tab === 'versions' && props.showVersions !== false ? (
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
