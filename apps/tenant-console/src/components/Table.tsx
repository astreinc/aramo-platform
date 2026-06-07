import type { ReactNode } from 'react';

// Settings S5b — hand-built Table on tokens (the new dense-list primitive).
//
// Why hand-built (no Radix): there is no Radix headless Table. The list
// surface is purely visual (header row + data rows; sort/select can land
// later if a real need surfaces — rule-of-three deferral). Keeping it
// thin avoids a dep we do not need and makes the per-cell styling
// (status badge, row disabled state) trivial to express in the consumer.
//
// Column-typed via the data row generic — the column's render maps a row
// to a cell; the header is the column's label. The empty/loading/error
// states are owned by the caller (the view holds the fetch state; the
// Table just renders rows when given them).

export interface TableColumn<Row> {
  readonly key: string;
  readonly header: ReactNode;
  readonly render: (row: Row) => ReactNode;
  readonly width?: string;
  readonly align?: 'left' | 'right' | 'center';
}

interface TableProps<Row> {
  caption?: ReactNode;
  columns: ReadonlyArray<TableColumn<Row>>;
  rows: ReadonlyArray<Row>;
  rowKey: (row: Row) => string;
  // S5b — the disabled-row affordance. The caller decides per-row; the
  // Table just applies the muted class. Default: never muted.
  rowMuted?: (row: Row) => boolean;
  emptyMessage?: ReactNode;
}

export function Table<Row>({
  caption,
  columns,
  rows,
  rowKey,
  rowMuted,
  emptyMessage,
}: TableProps<Row>) {
  return (
    <div className="tc-table-wrap">
      <table className="tc-table">
        {caption !== undefined && (
          <caption className="tc-table__caption">{caption}</caption>
        )}
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                style={{
                  width: col.width,
                  textAlign: col.align ?? 'left',
                }}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="tc-table__empty" colSpan={columns.length}>
                {emptyMessage ?? 'No rows.'}
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const muted = rowMuted?.(row) === true;
              return (
                <tr
                  key={rowKey(row)}
                  className={muted ? 'tc-table__row--muted' : undefined}
                  data-muted={muted ? 'true' : undefined}
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      style={{ textAlign: col.align ?? 'left' }}
                    >
                      {col.render(row)}
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
