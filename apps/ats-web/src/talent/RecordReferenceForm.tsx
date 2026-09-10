import { useCallback, useState } from 'react';

import { Card, InlineAlert } from '../ui';

import { recordReferenceAttestation } from './talent-api';

// TR-9 B1 (D5) — the modest capture affordance: a recruiter records a reference
// they already lawfully hold. The platform contacts no one. There is NO
// rating input — a reference with a number is a review, not evidence; the
// form (like the shape) refuses the concept. The captured reference renders
// thereafter through the dossier's existing evidence/timeline (no new read).

interface Props {
  recordId: string;
}

type StatementClass = 'SKILL' | 'WORK' | 'TENURE';

const STATEMENT_CLASS_LABELS: Array<{ value: StatementClass; label: string }> = [
  { value: 'WORK', label: 'Work / role' },
  { value: 'SKILL', label: 'Skill' },
  { value: 'TENURE', label: 'Tenure (continuity)' },
];

export function RecordReferenceForm({ recordId }: Props): JSX.Element {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [role, setRole] = useState('');
  const [relationship, setRelationship] = useState('');
  const [statementClass, setStatementClass] = useState<StatementClass>('WORK');
  const [statement, setStatement] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setBusy(true);
      setError(null);
      setMessage(null);
      try {
        const result = await recordReferenceAttestation(recordId, {
          attester: {
            name: name.trim(),
            ...(email.trim() ? { email: email.trim() } : {}),
            ...(company.trim() ? { company: company.trim() } : {}),
            ...(role.trim() ? { role: role.trim() } : {}),
          },
          relationship: relationship.trim(),
          statement_class: statementClass,
          statement: statement.trim(),
        });
        setMessage(
          result.recorded ? 'Reference recorded.' : 'This reference was already on record.',
        );
        setStatement('');
      } catch {
        setError('Could not record the reference. Check the required fields and try again.');
      } finally {
        setBusy(false);
      }
    },
    [recordId, name, email, company, role, relationship, statementClass, statement],
  );

  return (
    <Card>
      <form onSubmit={submit} aria-label="Record reference" className="talent-detail__refform">
        <div className="talent-detail__ctitle">Record reference</div>
        <p className="talent-detail__note" style={{ marginTop: 0 }}>
          Record a reference you already hold. The platform does not contact the referee.
        </p>
        <div className="talent-detail__refgrid">
          <label className="talent-detail__field">
            <span>Referee name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label className="talent-detail__field">
            <span>Referee email (optional)</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="talent-detail__field">
            <span>Referee company (optional)</span>
            <input value={company} onChange={(e) => setCompany(e.target.value)} />
          </label>
          <label className="talent-detail__field">
            <span>Referee role (optional)</span>
            <input value={role} onChange={(e) => setRole(e.target.value)} />
          </label>
          <label className="talent-detail__field">
            <span>Relationship</span>
            <input
              value={relationship}
              onChange={(e) => setRelationship(e.target.value)}
              placeholder="e.g. former manager"
              required
            />
          </label>
          <label className="talent-detail__field">
            <span>About</span>
            <select
              value={statementClass}
              onChange={(e) => setStatementClass(e.target.value as StatementClass)}
            >
              {STATEMENT_CLASS_LABELS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="talent-detail__field talent-detail__field--full">
          <span>What the referee said</span>
          <textarea value={statement} onChange={(e) => setStatement(e.target.value)} required />
        </label>
        <div className="talent-detail__refactions">
          <button
            type="submit"
            disabled={busy}
            className="tc-button tc-button--primary tc-button--md"
          >
            {busy ? 'Recording…' : 'Record reference'}
          </button>
        </div>
        {message !== null && (
          <div role="status">
            <InlineAlert variant="success">{message}</InlineAlert>
          </div>
        )}
        {error !== null && (
          <div role="alert">
            <InlineAlert variant="error">{error}</InlineAlert>
          </div>
        )}
      </form>
    </Card>
  );
}
