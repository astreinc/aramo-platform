import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, InlineAlert, SettingsSection, safeErrorMessage } from '@aramo/fe-foundation';
import {
  Letterhead,
  PreviewPaper,
  SampleValues,
  bindingMapFrom,
  fmtDate,
  previewContentFrom,
  previewTemplateDefault,
  useDocTemplateRoutes,
  type TemplateDefaultPreview,
} from '@aramo/document-templates-web';

// DOC-TEMPLATE-LIB-1 T-4 (§8.2; ADR-0034 D3, D4, D8) — an Aramo default as this
// organization will send it: the CURRENT version, rendered by the server with the
// organization's own details (name and address from the organization profile) and fixed
// sample values for everything else. Read-only: nothing is copied, stored or approved
// (adopting is a separate, explicit gallery action — ORG-UX-1 §5.1).
// The letterhead shows the organization name; the profile logo (when there is one) is
// added when a real document is generated.

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; preview: TemplateDefaultPreview };

export function AramoDefaultPreview({
  templateId,
  previewFn = previewTemplateDefault,
}: {
  readonly templateId: string;
  readonly previewFn?: typeof previewTemplateDefault;
}) {
  const navigate = useNavigate();
  const routes = useDocTemplateRoutes();
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    previewFn(templateId).then(
      (preview) => { if (!cancelled) setState({ status: 'ready', preview }); },
      (err: unknown) => { if (!cancelled) setState({ status: 'error', message: safeErrorMessage(err, 'Could not load this Aramo default.') }); },
    );
    return () => { cancelled = true; };
  }, [templateId, previewFn]);

  const back = (
    <Button unstyled className="dt-link" onClick={() => navigate(`${routes.list}/gallery`)} data-testid="dt-default-back">
      ← Template gallery
    </Button>
  );

  if (state.status !== 'ready') {
    return (
      <SettingsSection title="Aramo default">
        {back}
        {state.status === 'loading' ? <p className="org-muted">Loading…</p> : <InlineAlert variant="error">{state.message}</InlineAlert>}
      </SettingsSection>
    );
  }

  const p = state.preview;
  const map = bindingMapFrom(p.sample_values ?? []);
  const orgName = p.letterhead.organization_name ?? '';
  const content = previewContentFrom(p, `v${p.version_number} · Aramo default`, null);
  return (
    <SettingsSection
      title={p.title}
      description={`Aramo default · Updated ${fmtDate(p.updated_at)} · shown with your organization’s details`}
    >
      <div className="dt-root org-dt" data-testid="dt-default-preview">
        {back}
        <div className="org-dt-preview">
          <div className="dt-pvpaper org-dt-paper">
            <Letterhead info={{ src: null, tenantName: orgName }} variant="rendered" testId="dt-default-letterhead" />
            <PreviewPaper content={content} map={map} className="org-dt-paper__body" testId="dt-default-paper" />
          </div>
          <div className="org-dt-preview__side">
            <p className="org-muted" data-testid="dt-default-logo-note">
              {p.letterhead.logo_available
                ? 'Your organization logo from the profile is added when a document is generated.'
                : 'Add a logo to your organization profile to show it on generated documents.'}
            </p>
            {p.sample_values != null && p.sample_values.length > 0 ? <SampleValues samples={p.sample_values} compact /> : null}
          </div>
        </div>
      </div>
    </SettingsSection>
  );
}
