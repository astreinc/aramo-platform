import { useState, type FormEvent } from 'react';

// Shared intake-form island core (PUB-5 PR-5b, R-PUB5-4). Rendered as a REAL
// <form method="post" action="/intake/..."> that works with JS disabled (native
// POST → the handler 303-redirects to /thanks). When hydrated (client:visible),
// this adds inline validation, an async JSON submit, and in-place success/error
// states. Tokens-only styling via shared classes (forms.css). No new deps.
export interface IntakeField {
  name: string;
  label: string;
  type: 'text' | 'email' | 'textarea';
  required: boolean;
  maxLength: number;
  autoComplete?: string;
}

interface Props {
  action: string;
  fields: IntakeField[];
  submitLabel: string;
  successTitle: string;
  successBody: string;
}

type Status = 'idle' | 'submitting' | 'success' | 'error';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default function IntakeForm({
  action,
  fields,
  submitLabel,
  successTitle,
  successBody,
}: Props): React.JSX.Element {
  const [status, setStatus] = useState<Status>('idle');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);

  function validate(data: FormData): Record<string, string> {
    const next: Record<string, string> = {};
    for (const f of fields) {
      const value = String(data.get(f.name) ?? '').trim();
      if (f.required && value === '') {
        next[f.name] = `${f.label} is required.`;
      } else if (value.length > f.maxLength) {
        next[f.name] = `${f.label} is too long.`;
      } else if (f.type === 'email' && value !== '' && !EMAIL_RE.test(value)) {
        next[f.name] = 'Enter a valid email address.';
      }
    }
    return next;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);

    // Honeypot: a filled `website` means a bot — show the success state without
    // sending anything (mirrors the server's silent drop).
    if (String(data.get('website') ?? '') !== '') {
      setStatus('success');
      return;
    }

    const found = validate(data);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      return;
    }

    setErrors({});
    setServerError(null);
    setStatus('submitting');

    try {
      const body: Record<string, string> = {};
      for (const f of fields) body[f.name] = String(data.get(f.name) ?? '');
      const res = await fetch(action, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        setStatus('success');
        form.reset();
      } else if (res.status === 429) {
        setStatus('error');
        setServerError('Too many requests just now — please try again shortly.');
      } else if (res.status === 422) {
        setStatus('error');
        setServerError('Please check your entries and try again.');
      } else {
        setStatus('error');
        setServerError('Something went wrong. Please email hello@aramo.ai.');
      }
    } catch {
      setStatus('error');
      setServerError('Something went wrong. Please email hello@aramo.ai.');
    }
  }

  if (status === 'success') {
    return (
      <div className="form-status form-status--success" role="status">
        <p className="form-status__title">{successTitle}</p>
        <p className="form-status__body">{successBody}</p>
      </div>
    );
  }

  return (
    <form
      className="intake-form"
      method="post"
      action={action}
      onSubmit={onSubmit}
      noValidate
    >
      {fields.map((f) => (
        <div className="field" key={f.name}>
          <label className="field__label" htmlFor={`f-${f.name}`}>
            {f.label}
            {f.required ? '' : ' (optional)'}
          </label>
          {f.type === 'textarea' ? (
            <textarea
              id={`f-${f.name}`}
              name={f.name}
              className="field__control field__textarea"
              maxLength={f.maxLength}
              rows={4}
              required={f.required}
              aria-invalid={errors[f.name] ? 'true' : undefined}
            />
          ) : (
            <input
              id={`f-${f.name}`}
              name={f.name}
              type={f.type}
              className="field__control"
              maxLength={f.maxLength}
              required={f.required}
              autoComplete={f.autoComplete}
              aria-invalid={errors[f.name] ? 'true' : undefined}
            />
          )}
          {errors[f.name] ? (
            <p className="field__error">{errors[f.name]}</p>
          ) : null}
        </div>
      ))}

      {/* Honeypot — visually hidden, off the tab order, ignored by real users. */}
      <div className="honeypot" aria-hidden="true">
        <label htmlFor="f-website">Leave this field empty</label>
        <input
          id="f-website"
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
        />
      </div>

      {serverError ? (
        <p className="form-status form-status--error" role="alert">
          {serverError}
        </p>
      ) : null}

      <button
        className="btn btn--primary"
        type="submit"
        disabled={status === 'submitting'}
      >
        {status === 'submitting' ? 'Sending…' : submitLabel}
      </button>
    </form>
  );
}
