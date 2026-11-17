import { useEffect, useState, type FormEvent } from 'react';

import { errorMessage, profileApi, type SignProfile } from '../api';
import { Btn, ErrorBox, Field, TextIn } from '../ui';
import { useWorkspace } from '../workspace';

// UAT PRF-01 — Settings → My profile: the web counterpart of the Aramo Sign app's My
// profile (M-A12 W1-E). The SAME record (GET/PUT /v1/sign/me/profile), so a change on
// either platform shows on the other. Fields, labels and checks follow the app
// (mobile/sign/src/features/profile/signProfile.ts); the server checks again.

const DISPLAY_NAME_MAX = 120;
const FIELD_MAX = 200;
const E164 = /^\+[1-9][0-9]{1,14}$/;
const ISO2 = /^[A-Za-z]{2}$/;

type Key = 'title' | 'company' | 'phone' | 'address_line1' | 'address_line2' | 'city' | 'region' | 'postal_code' | 'country';
const ROWS: readonly { key: Key; label: string; placeholder: string }[] = [
  { key: 'title', label: 'Title', placeholder: 'Job title' },
  { key: 'company', label: 'Company', placeholder: 'Company name' },
  { key: 'phone', label: 'Phone', placeholder: '+15551234567' },
  { key: 'address_line1', label: 'Address', placeholder: 'Street address' },
  { key: 'address_line2', label: 'Address line 2', placeholder: 'Apartment, suite (optional)' },
  { key: 'city', label: 'City', placeholder: 'City' },
  { key: 'region', label: 'State / region', placeholder: 'State' },
  { key: 'postal_code', label: 'Postal code', placeholder: 'ZIP or postal code' },
  { key: 'country', label: 'Country', placeholder: 'Two-letter code, e.g. US' },
];

type Draft = { display_name: string } & Record<Key, string>;

// UAT PRF-02 — a field at its limit says so (the input stops there, as in the app).
export function atLimit(value: string, max: number): string | undefined {
  return value.length >= max ? `Up to ${max} characters. Anything longer isn’t kept.` : undefined;
}

function draftOf(p: SignProfile | null, fallbackName: string): Draft {
  const d = { display_name: p?.display_name ?? fallbackName } as Draft;
  for (const r of ROWS) d[r.key] = p?.[r.key] ?? '';
  return d;
}

export function validateDraft(d: Draft): Partial<Record<keyof Draft, string>> {
  const e: Partial<Record<keyof Draft, string>> = {};
  const name = d.display_name.trim();
  if (name.length === 0) e.display_name = 'Enter your name.';
  else if (name.length > DISPLAY_NAME_MAX) e.display_name = `Use at most ${DISPLAY_NAME_MAX} characters.`;
  for (const r of ROWS) if (d[r.key].trim().length > FIELD_MAX) e[r.key] = `Use at most ${FIELD_MAX} characters.`;
  const phone = d.phone.trim().replace(/[\s().-]/g, '');
  if (phone && !E164.test(phone)) e.phone = 'Use the international format, e.g. +15551234567.';
  const country = d.country.trim();
  if (country && !ISO2.test(country)) e.country = 'Use the two-letter country code, e.g. US.';
  return e;
}

function bodyOf(d: Draft): Omit<SignProfile, 'email' | 'updated_at'> {
  const opt = (x: string) => (x.trim() === '' ? null : x.trim());
  return {
    display_name: d.display_name.trim(),
    title: opt(d.title),
    company: opt(d.company),
    address_line1: opt(d.address_line1),
    address_line2: opt(d.address_line2),
    city: opt(d.city),
    region: opt(d.region),
    postal_code: opt(d.postal_code),
    country: opt(d.country)?.toUpperCase() ?? null,
    phone: opt(d.phone),
  };
}

export function MyProfileSection() {
  const { ctx, toast } = useWorkspace();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof Draft, string>>>({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    profileApi.get().then(
      (p) => setDraft(draftOf(p, ctx.user.display_name ?? '')),
      (e: unknown) => setError(errorMessage(e, 'Couldn’t load your profile.')),
    );
  }, [ctx.user.display_name]);

  const set = (k: keyof Draft, v: string) => setDraft((d) => (d === null ? d : { ...d, [k]: v }));

  const save = async (ev: FormEvent) => {
    ev.preventDefault();
    if (draft === null) return;
    const e = validateDraft(draft);
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    setSaving(true);
    setError('');
    try {
      const saved = await profileApi.put(bodyOf(draft));
      setDraft(draftOf(saved, draft.display_name));
      toast('Profile saved');
    } catch (err) {
      setError(errorMessage(err, 'Couldn’t save your profile. Try again.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="sg-card" data-testid="settings-my-profile">
      <div className="sg-card__head">
        My profile <span className="sg-tag sg-tag--blue">Sign only</span>
      </div>
      <div className="sg-card__body">
        <p className="sg-help" style={{ marginTop: 0 }}>
          Used to fill in your details on documents you sign yourself. The same profile as in the Aramo Sign app.
        </p>
        {error !== '' ? <ErrorBox>{error}</ErrorBox> : null}
        {draft === null ? (
          error === '' ? <p className="sg-muted">Loading…</p> : null
        ) : (
          <form className="sg-grid" style={{ gap: 12 }} onSubmit={(e) => void save(e)} noValidate>
            {ctx.user.email !== null && ctx.user.email !== undefined ? <div className="sg-muted">Email: {ctx.user.email}</div> : null}
            <Field label="Name" htmlFor="profile-name" error={errors.display_name ?? atLimit(draft.display_name, DISPLAY_NAME_MAX)}>
              <TextIn id="profile-name" data-testid="profile-name" value={draft.display_name} maxLength={DISPLAY_NAME_MAX} onChange={(e) => set('display_name', e.target.value)} />
            </Field>
            <div className="sg-grid sg-grid--2">
              {ROWS.map((r) => (
                <Field key={r.key} label={`${r.label} (optional)`} htmlFor={`profile-${r.key}`} error={errors[r.key] ?? atLimit(draft[r.key], FIELD_MAX)}>
                  <TextIn
                    id={`profile-${r.key}`}
                    data-testid={`profile-${r.key}`}
                    value={draft[r.key]}
                    placeholder={r.placeholder}
                    maxLength={FIELD_MAX}
                    onChange={(e) => set(r.key, e.target.value)}
                  />
                </Field>
              ))}
            </div>
            <div>
              <Btn variant="primary" type="submit" disabled={saving} data-testid="profile-save">
                {saving ? 'Saving…' : 'Save'}
              </Btn>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
