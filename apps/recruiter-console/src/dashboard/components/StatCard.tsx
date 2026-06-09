import { Card } from '@aramo/fe-foundation';

// StatCard — a fe-foundation Card wrapper rendering a large numeric value
// + a label. Local to recruiter-console (fe-foundation FROZEN); promote
// to the foundation when a 2nd consumer appears (rule-of-three —
// R3-Tabs / R5-ResumeUploadSection / R6-wizard discipline).

interface StatCardProps {
  readonly label: string;
  readonly value: number;
  readonly hint?: string;
}

export function StatCard({ label, value, hint }: StatCardProps) {
  return (
    <Card>
      <div className="r-home-stat">
        <p
          className="r-home-stat__value"
          style={{
            margin: 0,
            fontSize: '2rem',
            fontWeight: 600,
            lineHeight: 1.1,
          }}
        >
          {value.toLocaleString()}
        </p>
        <p
          className="r-home-stat__label"
          style={{
            margin: '0.25rem 0 0 0',
            fontSize: '0.875rem',
            color: 'var(--tc-text-muted, #6b7280)',
          }}
        >
          {label}
        </p>
        {hint !== undefined && (
          <p
            className="r-home-stat__hint"
            style={{
              margin: '0.25rem 0 0 0',
              fontSize: '0.75rem',
              color: 'var(--tc-text-muted, #9ca3af)',
            }}
          >
            {hint}
          </p>
        )}
      </div>
    </Card>
  );
}
