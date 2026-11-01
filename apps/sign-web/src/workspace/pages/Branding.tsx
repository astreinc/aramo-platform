import { useEffect, useRef, useState } from 'react';
import { Input } from '@aramo/fe-foundation';

import { DEFAULT_PRIMARY, LOGO_MAX_BYTES, LOGO_TYPES, brandingApi, fileToBase64, normalizeHex, textOn, type Branding } from '../branding-api';
import { errorMessage } from '../api';
import { orgLinkWithReturn } from '../org-link';
import { Btn, ErrorBox, Field, Icon, Loading, TextIn, fmtBytes, fmtDate } from '../ui';
import { useWorkspace } from '../workspace';

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.10 — Settings → Branding.
// The organization's logo, brand colours and sender display name, shown to recipients on the
// signing page, in Aramo Sign emails and on the certificate of completion. The backend reports
// whether branding is offered (available), whether the plan includes it (entitled) and who may
// change it (can_edit, sign:settings:manage). Until the feature is offered the page says so and
// recipients see the Aramo Sign look.

export function BrandingSection() {
  const [branding, setBranding] = useState<Branding | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    brandingApi
      .get()
      .then(setBranding)
      .catch((e: unknown) => setError(errorMessage(e)));
  }, []);
  if (error !== '' && branding === null) return <ErrorBox>{error}</ErrorBox>;
  if (branding === null) return <Loading />;
  return (
    <div className="sg-grid sg-grid--2" style={{ alignItems: 'start' }}>
      {!branding.available ? <NotOfferedCard /> : !branding.entitled ? <NotInPlanCard /> : <BrandingEditor branding={branding} onSaved={setBranding} />}
      <OrgProfileCard />
    </div>
  );
}

function NotOfferedCard() {
  return (
    <section className="sg-card" data-testid="branding-not-offered">
      <div className="sg-card__head">
        Branding <span className="sg-card__end sg-tag sg-tag--grey">Coming soon</span>
      </div>
      <div className="sg-card__body">
        <p className="sg-help" style={{ marginTop: 0 }}>
          Custom branding (your logo, colours and sender name on signing pages, emails and the certificate of completion) isn&apos;t available yet. Recipients
          see the Aramo Sign look.
        </p>
      </div>
    </section>
  );
}

function NotInPlanCard() {
  const { base } = useWorkspace();
  return (
    <section className="sg-card" data-testid="branding-not-in-plan">
      <div className="sg-card__head">Branding</div>
      <div className="sg-card__body">
        <p className="sg-help" style={{ marginTop: 0 }}>
          Custom branding is included in the Business, Professional and Enterprise plans. Recipients see the Aramo Sign look on your current plan.
        </p>
        <a className="sg-btn sg-btn--sm" href={`${base}/settings/billing`}>
          View plans
        </a>
      </div>
    </section>
  );
}

function OrgProfileCard() {
  const { ctx } = useWorkspace();
  const { pathname } = window.location;
  return (
    <section className="sg-card">
      <div className="sg-card__head">Organization profile</div>
      <div className="sg-card__body">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="sg-brand__mark">{ctx.tenant.name.charAt(0).toUpperCase()}</span>
          <strong>{ctx.tenant.name}</strong>
        </div>
        <p className="sg-help">The organization name comes from Organization administration, shared by every Aramo app.</p>
        {ctx.organization_url !== null ? (
          <a className="sg-btn sg-btn--sm" href={orgLinkWithReturn(ctx.organization_url, `${window.location.origin}${pathname}`)}>
            Open organization profile <Icon name="ext" size={12} />
          </a>
        ) : null}
      </div>
    </section>
  );
}

function ColorField({ id, label, value, onChange, disabled, help }: { id: string; label: string; value: string; onChange: (v: string) => void; disabled: boolean; help?: string }) {
  const valid = value === '' || normalizeHex(value) !== null;
  return (
    <Field label={label} htmlFor={id} help={help} error={valid ? undefined : 'Enter a colour as #RRGGBB.'}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Input
          unstyled
          type="color"
          aria-label={`${label} picker`}
          value={normalizeHex(value) ?? DEFAULT_PRIMARY}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          style={{ width: 44, height: 36, padding: 0, border: 'none', background: 'none' }}
        />
        <TextIn id={id} value={value} placeholder="Aramo default" maxLength={7} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      </div>
    </Field>
  );
}

export function BrandingEditor({ branding, onSaved }: { branding: Branding; onSaved: (b: Branding) => void }) {
  const { toast } = useWorkspace();
  const [name, setName] = useState(branding.display_name ?? '');
  const [primary, setPrimary] = useState(branding.primary_color ?? '');
  const [accent, setAccent] = useState(branding.accent_color ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const ro = !branding.can_edit;

  const primaryOk = primary === '' || normalizeHex(primary) !== null;
  const accentOk = accent === '' || normalizeHex(accent) !== null;
  const nameOk = name.trim().length <= 80;
  const changed = (name.trim() || null) !== branding.display_name || (normalizeHex(primary) ?? null) !== branding.primary_color || (normalizeHex(accent) ?? null) !== branding.accent_color;

  const run = async (work: () => Promise<Branding>, done: string) => {
    setBusy(true);
    setError('');
    try {
      onSaved(await work());
      toast(done);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(() => brandingApi.save({ display_name: name.trim() === '' ? null : name.trim(), primary_color: normalizeHex(primary), accent_color: normalizeHex(accent) }), 'Branding saved');

  const upload = async (file: File | undefined) => {
    if (fileRef.current) fileRef.current.value = '';
    if (file === undefined) return;
    if (!(LOGO_TYPES as readonly string[]).includes(file.type)) {
      setError('The logo must be a PNG or JPEG image.');
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      setError('The logo must be 256 KB or smaller.');
      return;
    }
    await run(async () => brandingApi.uploadLogo(file.type, await fileToBase64(file)), 'Logo uploaded');
  };

  const previewPrimary = normalizeHex(primary) ?? DEFAULT_PRIMARY;
  return (
    <section className="sg-card" data-testid="branding-editor">
      <div className="sg-card__head">
        Branding
        {ro ? <span className="sg-card__end sg-tag sg-tag--grey">Read-only</span> : null}
      </div>
      <div className="sg-card__body sg-grid" style={{ gap: 12 }}>
        <p className="sg-help" style={{ marginTop: 0 }}>
          Recipients see your logo, colours and sender name on the signing page, in Aramo Sign emails and on the certificate of completion.
        </p>
        <Field label="Sender display name" htmlFor="b-name" help='Emails are signed "<name> via Aramo Sign". Leave empty for none.' error={nameOk ? undefined : 'Use 80 characters or fewer.'}>
          <TextIn id="b-name" value={name} maxLength={80} disabled={ro} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="sg-grid sg-grid--2">
          <ColorField id="b-primary" label="Primary colour" value={primary} onChange={setPrimary} disabled={ro} help="Buttons and the header mark." />
          <ColorField id="b-accent" label="Accent colour" value={accent} onChange={setAccent} disabled={ro} help="Highlights and hover states." />
        </div>
        <Field label="Logo" htmlFor="b-logo" help="PNG or JPEG, up to 256 KB, 16 to 4096 pixels on each side.">
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            {branding.logo !== null ? (
              <img src={branding.logo.url} alt="Current logo" style={{ maxHeight: 40, maxWidth: 160 }} data-testid="branding-logo" />
            ) : (
              <span className="sg-help">No logo</span>
            )}
            {branding.logo !== null ? (
              <span className="sg-help">
                {branding.logo.width}×{branding.logo.height} · {fmtBytes(branding.logo.byte_size)}
              </span>
            ) : null}
            {!ro ? (
              <>
                <Input
                  unstyled
                  ref={fileRef}
                  id="b-logo"
                  type="file"
                  accept="image/png,image/jpeg"
                  style={{ display: 'none' }}
                  data-testid="branding-logo-input"
                  onChange={(e) => void upload(e.target.files?.[0])}
                />
                <Btn size="sm" disabled={busy} onClick={() => fileRef.current?.click()}>
                  {branding.logo !== null ? 'Replace logo' : 'Upload logo'}
                </Btn>
                {branding.logo !== null ? (
                  <Btn size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => brandingApi.removeLogo(), 'Logo removed')}>
                    Remove
                  </Btn>
                ) : null}
              </>
            ) : null}
          </div>
        </Field>
        <div className="sg-card" style={{ padding: 12 }} aria-label="Preview" data-testid="branding-preview">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {branding.logo !== null ? (
              <img src={branding.logo.url} alt="" style={{ maxHeight: 32, maxWidth: 120 }} />
            ) : (
              <span className="sg-brand__mark" style={{ background: previewPrimary, color: textOn(previewPrimary) }}>
                {(name.trim() || 'S').charAt(0).toUpperCase()}
              </span>
            )}
            <strong>{name.trim() || 'Aramo Sign'}</strong>
            <span style={{ flex: 1 }} />
            <span style={{ background: previewPrimary, color: textOn(previewPrimary), borderRadius: 8, padding: '6px 12px', fontWeight: 600, fontSize: 13 }}>Review &amp; sign</span>
          </div>
        </div>
        {branding.updated_at !== null ? <div className="sg-help">Last changed {fmtDate(branding.updated_at, true)}</div> : null}
        {!ro ? (
          <div>
            <Btn variant="primary" disabled={!changed || !primaryOk || !accentOk || !nameOk || busy} onClick={() => void save()} data-testid="branding-save">
              Save
            </Btn>
          </div>
        ) : (
          <p className="sg-help">Only an Aramo Sign administrator can change branding.</p>
        )}
        {error !== '' ? <ErrorBox>{error}</ErrorBox> : null}
      </div>
    </section>
  );
}
