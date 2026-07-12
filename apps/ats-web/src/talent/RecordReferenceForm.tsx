import { useCallback, useState } from 'react';

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
    <form onSubmit={submit} aria-label="Record reference">
      <h3>Record reference</h3>
      <p>Record a reference you already hold. The platform does not contact the referee.</p>
      <label>
        Referee name
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <label>
        Referee email (optional)
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label>
        Referee company (optional)
        <input value={company} onChange={(e) => setCompany(e.target.value)} />
      </label>
      <label>
        Referee role (optional)
        <input value={role} onChange={(e) => setRole(e.target.value)} />
      </label>
      <label>
        Relationship
        <input
          value={relationship}
          onChange={(e) => setRelationship(e.target.value)}
          placeholder="e.g. former manager"
          required
        />
      </label>
      <label>
        About
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
      <label>
        What the referee said
        <textarea value={statement} onChange={(e) => setStatement(e.target.value)} required />
      </label>
      <button type="submit" disabled={busy}>
        {busy ? 'Recording…' : 'Record reference'}
      </button>
      {message !== null && <p role="status">{message}</p>}
      {error !== null && <p role="alert">{error}</p>}
    </form>
  );
}
