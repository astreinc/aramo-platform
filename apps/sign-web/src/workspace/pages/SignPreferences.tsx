import { useEffect, useState } from 'react';

import { SIGN_DATE_FORMATS, errorMessage, savedMarksApi } from '../api';
import { ErrorBox, Field, Sel } from '../ui';
import { useWorkspace } from '../workspace';

// UAT SIG-12 — Settings → Preferences → Date format: the web counterpart of the Aramo
// Sign app's Account → Preferences → Date format (M-A12 W1-E.2). The format is stamped on
// envelopes the user sends, so every "Date signed" on them reads that way. The app's
// "Default field size" is not shown: the web field editor does not use it.

export function SignPreferencesSection() {
  const { toast } = useWorkspace();
  const [format, setFormat] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    savedMarksApi.settings().then(
      (s) => setFormat(typeof s?.date_format === 'string' ? s.date_format : null),
      (e: unknown) => setError(errorMessage(e, 'Couldn’t load your preferences.')),
    );
  }, []);

  const change = async (next: string) => {
    const before = format;
    setFormat(next);
    setSaving(true);
    setError('');
    try {
      await savedMarksApi.updateSettings({ date_format: next });
      toast('Date format saved');
    } catch (e) {
      setFormat(before);
      setError(errorMessage(e, 'Couldn’t save the setting. Try again.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="sg-card" data-testid="settings-preferences">
      <div className="sg-card__head">
        Preferences <span className="sg-tag sg-tag--blue">Sign only</span>
      </div>
      <div className="sg-card__body">
        {error !== '' ? <ErrorBox>{error}</ErrorBox> : null}
        {format !== null ? (
          <Field label="Date format" htmlFor="pref-date-format" help="How Date signed appears on envelopes you send. It applies to envelopes you send from now on.">
            <Sel id="pref-date-format" data-testid="pref-date-format" value={format} disabled={saving} onChange={(e) => void change(e.target.value)}>
              {SIGN_DATE_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </Sel>
          </Field>
        ) : error === '' ? (
          <p className="sg-muted">Loading…</p>
        ) : null}
      </div>
    </section>
  );
}
