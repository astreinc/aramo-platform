import { useMemo } from 'react';
import { Button, Checkbox, Dialog, DialogClose, Select } from '@aramo/fe-foundation';

import { useReturnFocus } from './primitives';
import { blockDiff, diffStats, type DiffBlock, type DiffSeg, type RowKind } from './diff';

// PLATFORM-UX-1 F-9 (handoff §10.7 Compare) — the NEW VersionDiff: a min(1180px,96vw) ×
// min(860px,92vh) modal comparing any two of Draft and the versions. LCS block diff +
// word diff (./diff); a 44px + / − / ~ marker column (colour is never the only cue) and
// two content columns. Built on the fe-foundation Dialog (focus trap, Esc, focus return).

export interface DiffSide {
  /** 'draft' or a version id. */
  readonly key: string;
  readonly label: string;
  readonly sub: string;
  readonly blocks: readonly DiffBlock[];
}

export interface VersionDiffProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly sides: readonly DiffSide[];
  readonly left: string;
  readonly right: string;
  readonly onLeft: (key: string) => void;
  readonly onRight: (key: string) => void;
  readonly changesOnly: boolean;
  readonly onChangesOnly: (on: boolean) => void;
}

const MARK: Readonly<Record<RowKind, string>> = { same: '', add: '+', del: '−', chg: '~' };
const SR: Readonly<Record<RowKind, string>> = { same: 'Unchanged', add: 'Added', del: 'Removed', chg: 'Changed' };

function Segs({ segs }: { readonly segs: readonly DiffSeg[] }) {
  return (
    <>
      {segs.map((w, i) => (
        <span key={i} className={`pws-dseg pws-dseg--${w.kind}${w.isVar ? ' pws-dseg--var' : ''}`}>
          {w.t}
        </span>
      ))}
    </>
  );
}

export function VersionDiff(props: VersionDiffProps) {
  useReturnFocus(props.open);
  const A = props.sides.find((s) => s.key === props.left) ?? props.sides[0];
  const B = props.sides.find((s) => s.key === props.right) ?? props.sides[0];
  const rows = useMemo(() => (A !== undefined && B !== undefined ? blockDiff(A.blocks, B.blocks) : []), [A, B]);
  const stats = diffStats(rows);
  const shown = rows.filter((r) => !props.changesOnly || r.kind !== 'same');
  const identical = rows.every((r) => r.kind === 'same');
  const options = props.sides.map((s) => (
    <option key={s.key} value={s.key}>
      {s.key === 'draft' ? 'Draft' : `${s.label} · ${s.sub.split(' · ')[0] ?? ''}`}
    </option>
  ));
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange} title="Compare versions">
      <div className="pws-cmp">
        <div className="pws-cmp__controls">
          <Select unstyled className="pws-cmp__sel" aria-label="Left version" value={props.left} onChange={(e) => props.onLeft(e.target.value)}>
            {options}
          </Select>
          <Button
            unstyled
            className="pws-cmp__swap"
            aria-label="Swap"
            onClick={() => {
              const l = props.left;
              props.onLeft(props.right);
              props.onRight(l);
            }}
          >
            ⇄
          </Button>
          <Select unstyled className="pws-cmp__sel" aria-label="Right version" value={props.right} onChange={(e) => props.onRight(e.target.value)}>
            {options}
          </Select>
          <span className="pws-cmp__stats">
            <span className="pws-cmp__stat pws-cmp__stat--add">
              <span>{stats.added}</span> <span>Added</span>
            </span>
            <span className="pws-cmp__stat pws-cmp__stat--chg">
              <span>{stats.changed}</span> <span>Changed</span>
            </span>
            <span className="pws-cmp__stat pws-cmp__stat--del">
              <span>{stats.removed}</span> <span>Removed</span>
            </span>
            <span className="pws-cmp__stat pws-cmp__stat--same">
              <span>{stats.unchanged}</span> <span>Unchanged</span>
            </span>
          </span>
          <label className="pws-cmp__co">
            <Checkbox unstyled className="pws-check-in" checked={props.changesOnly} onChange={(e) => props.onChangesOnly(e.target.checked)} />
            Changes only
          </label>
          <DialogClose className="pws-cmp__close" aria-label="Close">
            ×
          </DialogClose>
        </div>
        <div className="pws-cmp__cols" aria-hidden="true">
          <span />
          <span className="pws-cmp__colh">
            {A?.label} <span className="pws-cmp__colsub">· {A?.sub}</span>
          </span>
          <span className="pws-cmp__colh">
            {B?.label} <span className="pws-cmp__colsub">· {B?.sub}</span>
          </span>
        </div>
        <div className="pws-cmp__rows" role="list" tabIndex={0} aria-label={`${A?.label ?? ''} compared with ${B?.label ?? ''}`}>
          {shown.map((r, i) => (
            <div key={i} role="listitem" className={`pws-drow pws-drow--${r.kind}`}>
              <span className="pws-drow__mark">
                <span aria-hidden="true">{MARK[r.kind]}</span>
                <span className="pws-sr">{SR[r.kind]}</span>
              </span>
              <div className={`pws-drow__l${r.lt === 'h2' ? ' pws-drow--h' : ''}`}>{r.L.length === 0 ? <span className="pws-drow__none">—</span> : <Segs segs={r.L} />}</div>
              <div className={`pws-drow__r${r.rt === 'h2' ? ' pws-drow--h' : ''}`}>{r.R.length === 0 ? <span className="pws-drow__none">—</span> : <Segs segs={r.R} />}</div>
            </div>
          ))}
          {identical && props.changesOnly ? <div className="pws-cmp__same">These two versions have identical content.</div> : null}
        </div>
      </div>
    </Dialog>
  );
}
