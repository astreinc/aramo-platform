import { Table, type TableColumn } from '@aramo/fe-foundation';
import type { ReactNode } from 'react';

// DataTable — the FROZEN fe-foundation Table, themed (Lead directive: "prefer
// frozen Table themed; add dense styling"). The token re-map (theme.css) gives
// it the Confident Blue palette; the `.rc-tablewrap` wrapper applies the mockup
// density pass (compact rows, hairline rules, hover) via ui.css. Zero lib edits.
//
// Props mirror the frozen TableProps (which the lib does not export). Generic
// over the row type, exactly like the frozen Table.
interface DataTableProps<Row> {
  readonly caption?: ReactNode;
  readonly columns: ReadonlyArray<TableColumn<Row>>;
  readonly rows: ReadonlyArray<Row>;
  readonly rowKey: (row: Row) => string;
  readonly rowMuted?: (row: Row) => boolean;
  readonly emptyMessage?: ReactNode;
}

export function DataTable<Row>(props: DataTableProps<Row>) {
  return (
    <div className="rc-tablewrap">
      <Table<Row> {...props} />
    </div>
  );
}

export type { TableColumn };
