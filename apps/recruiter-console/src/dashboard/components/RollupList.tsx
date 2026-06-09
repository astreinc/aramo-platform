// RollupList — a status-breakdown display for the requisition + pipeline
// rollups. A simple list of (label, count) pairs with a total header.
// Local to recruiter-console (fe-foundation FROZEN); promote to the
// foundation when a 2nd consumer appears (rule-of-three).

export interface RollupListItem {
  readonly key: string;
  readonly label: string;
  readonly count: number;
}

interface RollupListProps {
  readonly total: number;
  readonly items: readonly RollupListItem[];
  readonly emptyMessage?: string;
}

export function RollupList({ total, items, emptyMessage }: RollupListProps) {
  return (
    <div className="r-home-rollup">
      <p
        className="r-home-rollup__total"
        style={{
          margin: '0 0 0.5rem 0',
          fontSize: '1.25rem',
          fontWeight: 600,
        }}
      >
        {total.toLocaleString()}{' '}
        <span
          style={{
            fontWeight: 400,
            fontSize: '0.875rem',
            color: 'var(--tc-text-muted, #6b7280)',
          }}
        >
          total
        </span>
      </p>
      {items.length === 0 ? (
        <p
          style={{
            margin: 0,
            fontSize: '0.875rem',
            color: 'var(--tc-text-muted, #6b7280)',
          }}
        >
          {emptyMessage ?? 'No breakdown available.'}
        </p>
      ) : (
        <ul
          className="r-home-rollup__list"
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: '0.25rem',
          }}
        >
          {items.map((it) => (
            <li
              key={it.key}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: '0.875rem',
              }}
            >
              <span>{it.label}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                {it.count.toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
