import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, safeErrorMessage, useToast, type Session } from '@aramo/fe-foundation';
import {
  TemplateStudio,
  adoptTemplate,
  canAuthorTemplates,
  fetchTemplateLibrary,
  galleryDefaultOf,
  galleryStudioDataSource,
  previewTemplateDefault,
  useDocTemplateRoutes,
  type TemplateLibraryView,
} from '@aramo/document-templates-web';

import { OrgModal } from '../ui/OrgPage';

import { OrgStudioHost, orgStudioErrorMessage, useOrgStudioAccount } from './OrgStudioHost';
import { RESPONSIBILITY_SENTENCE } from './TemplateGalleryPage';
import { ourTemplateOfType } from './templates-view';
import './templates.css';

// TEMPLATE-STUDIO-1 S-2 (directive §4.3–§4.5; conforming amendment #3; ADR-0034 D3) —
// /org/document-templates/aramo/:templateId: an Aramo default opened in the shared Template
// Studio, READ ONLY, in Preview (the current version, rendered with the organization's
// branding by GET /library/:id/preview; no Versions, no Compare). Header action:
//   • Adopt (document_template:author or :manage, and the organization has no template of
//     this type) → the existing confirmation with the responsibility sentence (ORG-UX-1
//     §5.5) → POST /adopt → the new draft opens at /org/document-templates/:newId;
//   • "In Our templates" when the organization already has one;
//   • nothing for a read-only session.
// Retires AramoDefaultPreview. The Organization host frame (token map, compact nav, account
// menu) is S-1's OrgStudioHost; the Org shell's full-width mode covers this path
// (sections.ts isOrgStudioPath).

interface Props {
  readonly session: Session;
  readonly templateId: string;
  /** The Organization crumb's link (org admins); null for template authors. */
  readonly organizationHref?: string | null;
  /** Organization administrator (the Studio account menu's badge). */
  readonly admin?: boolean;
  readonly libraryFn?: typeof fetchTemplateLibrary;
  readonly previewFn?: typeof previewTemplateDefault;
  readonly adoptFn?: typeof adoptTemplate;
}

type Action = { kind: 'none' } | { kind: 'adopt'; name: string } | { kind: 'in-ours'; ourTemplateId: string };

export function actionFor(library: TemplateLibraryView | null, templateId: string, canAuthor: boolean): Action {
  if (library === null) return { kind: 'none' };
  const def = galleryDefaultOf(library, templateId);
  if (def === null) return { kind: 'none' };
  const ours = ourTemplateOfType(library, def.document_type_id);
  if (ours !== null) return { kind: 'in-ours', ourTemplateId: ours.id };
  return canAuthor && def.configurable ? { kind: 'adopt', name: def.name } : { kind: 'none' };
}

export function AramoDefaultStudio(props: Props) {
  // Keyed by id: moving between defaults starts a fresh Studio.
  return <AramoDefaultStudioInner key={props.templateId} {...props} />;
}

function AramoDefaultStudioInner({ session, templateId, organizationHref = null, admin = false, libraryFn = fetchTemplateLibrary, previewFn = previewTemplateDefault, adoptFn = adoptTemplate }: Props) {
  const navigate = useNavigate();
  const routes = useDocTemplateRoutes();
  const toast = useToast();
  const canAuthor = canAuthorTemplates(session);
  // One library read, shared by the Studio source and the header action.
  const library = useMemo(() => libraryFn(), [libraryFn]);
  const dataSource = useMemo(
    () => galleryStudioDataSource({ library, previewFn, galleryTo: `${routes.list}/gallery`, listHref: routes.list, organizationHref }),
    [library, previewFn, routes.list, organizationHref],
  );
  const renderAccount = useOrgStudioAccount(admin);
  const [lib, setLib] = useState<TemplateLibraryView | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [adoptError, setAdoptError] = useState('');

  useEffect(() => {
    let live = true;
    library.then(
      (l) => {
        if (live) setLib(l);
      },
      () => undefined, // the Studio shows the load error
    );
    return () => {
      live = false;
    };
  }, [library]);

  const action = actionFor(lib, templateId, canAuthor);

  async function confirmAdopt(name: string) {
    setBusy(true);
    setAdoptError('');
    try {
      const { template } = await adoptFn(templateId);
      setConfirming(false);
      toast.show(`${name} added to Our templates as a draft. Nothing is used until it’s approved.`);
      navigate(routes.detail(template.id));
    } catch (err) {
      setAdoptError(safeErrorMessage(err, 'Could not adopt this template.'));
    } finally {
      setBusy(false);
    }
  }

  const actions =
    action.kind === 'adopt' ? (
      <Button
        unstyled
        className="pws-btn34 pws-btn34--terra"
        onClick={() => {
          setAdoptError('');
          setConfirming(true);
        }}
        data-testid="studio-adopt"
      >
        Adopt
      </Button>
    ) : action.kind === 'in-ours' ? (
      <Link to={routes.detail(action.ourTemplateId)} className="pws-btn34" data-testid="studio-in-ours">
        In Our templates
      </Link>
    ) : null;

  return (
    <OrgStudioHost testId="aramo-default-studio">
      <TemplateStudio
        context="organization"
        dataSource={dataSource}
        templateId={templateId}
        renderAccount={renderAccount}
        formatError={orgStudioErrorMessage}
        actions={actions}
      />
      {action.kind === 'adopt' ? (
        <OrgModal
          open={confirming}
          onOpenChange={(open) => {
            if (!open && !busy) setConfirming(false);
          }}
          title={`Adopt ${action.name}?`}
          subtitle="This creates a draft in Our templates. Nothing is used until it’s approved."
          testId="gallery-adopt-modal"
          footer={
            <>
              <button type="button" className="ox-btn ox-btn--secondary" onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="ox-btn ox-btn--primary" onClick={() => void confirmAdopt(action.name)} disabled={busy} data-testid="gallery-adopt-confirm">
                Adopt
              </button>
            </>
          }
        >
          <p className="ox-tpl__modaltext">{RESPONSIBILITY_SENTENCE}</p>
          {adoptError !== '' ? (
            <p className="ox-error" role="alert">
              {adoptError}
            </p>
          ) : null}
        </OrgModal>
      ) : null}
    </OrgStudioHost>
  );
}
