import type { ReactNode } from 'react';

import type { TableColumn } from '../components/Table';

// DataTable — the app-layer, token-styled table (Phase 2A, per the Lead's
// row-click ruling). Phase 1 wrapped the frozen Table; the frozen Table
// exposes no per-row handler/className seam, so — rather than fork a table per
// surface or add a seam to the frozen lib — the rows are rendered HERE with
// token-styled semantic <tr>/<td>. ONE DataTable, used by every surface. Still
// ZERO @aramo/fe-foundation diff. The column shape is the frozen `TableColumn`
// so it stays a drop-in for the existing surfaces.
//
// A11Y (DDR §6/§8, WCAG-AA): the row's PRIMARY cell must contain a real
// focusable link (entity name → detail route) — that anchor is the keyboard /
// screen-reader navigation path, supplied by the surface in `columns[0].render`.
// `onRowClick` is a MOUSE-ONLY progressive enhancement, never the sole
// affordance: it sits on <tr onClick>, carries no role/tabindex, and ignores
// clicks that originate inside an interactive child (so the in-cell link is the
// single source of navigation, never double-fired).

interface DataTableProps<Row> {
  readonly caption?: ReactNode;
  readonly columns: ReadonlyArray<TableColumn<Row>>;
  readonly rows: ReadonlyArray<Row>;
  readonly rowKey: (row: Row) => string;
  readonly rowMuted?: (row: Row) => boolean;
  readonly emptyMessage?: ReactNode;
  /** Mouse-only row-activation enhancement. The in-cell link is the a11y path. */
  readonly onRowClick?: (row: Row) => void;
  readonly rowClassName?: (row: Row) => string | undefined;
}

const INTERACTIVE = 'a, button, input, select, textarea, label';

export function DataTable<Row>({
  caption,
  columns,
  rows,
  rowKey,
  rowMuted,
  emptyMessage,
  onRowClick,
  rowClassName,
}: DataTableProps<Row>) {
  const click = onRowClick;
  return (
    <div className="rc-tablewrap">
      <table className="rc-table">
        {caption != null ? (
          <caption className="rc-table__caption">{caption}</caption>
        ) : null}
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                style={{
                  textAlign: c.align ?? 'left',
                  width: c.width,
                }}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="rc-table__empty" colSpan={columns.length}>
                {emptyMessage ?? 'No results.'}
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const classes = [
                rowMuted?.(row) ? 'rc-table__row--muted' : '',
                click ? 'rc-row--clickable' : '',
                rowClassName?.(row) ?? '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <tr
                  key={rowKey(row)}
                  className={classes || undefined}
                  onClick={
                    click
                      ? (e) => {
                          // Ignore clicks that land on the real nav path (the
                          // in-cell anchor) or any other interactive control.
                          if (
                            e.target instanceof Element &&
                            e.target.closest(INTERACTIVE)
                          ) {
                            return;
                          }
                          click(row);
                        }
                      : undefined
                  }
                >
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      style={c.align ? { textAlign: c.align } : undefined}
                    >
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
