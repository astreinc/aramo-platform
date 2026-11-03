import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { hasScope, logout, redirectToLogin, type Session } from '@aramo/fe-foundation';
import { FixedFormStudio, TemplateStudio, type StudioAccountSlot } from '@aramo/document-templates-web';

import { useIdentity } from '../identity/identity';
import { AccountMenu } from '../shell/AccountMenu';
import { useSetEntityCrumb } from '../shell/crumbs';

import { DOC_TEMPLATE_MANAGE_SCOPE, documentTemplatesApi } from './document-templates-api';
import { platformFixedFormDataSource } from './platform-fixed-form-source';
import { platformStudioDataSource } from './platform-studio-source';
import { templateErrorMessage } from './template-errors';
import './studio-theme.css';

// PLATFORM-UX-1 F-9 (directive R-12) — /document-templates/:id. The Template Studio
// REPLACES the former detail view at the same path; the route and this export keep
// their names so App.tsx is unchanged. Keyed by id so moving between templates starts a
// fresh Studio (no draft state leaks across templates).
//
// TEMPLATE-STUDIO-1 S-0 (directive §2) — the Studio is the shared lib component now; this
// is platform-web's thin wrapper: the platform data source, the console account menu, the
// console breadcrumb, the platform refusal copy and the --ts-* → --pw-* token map
// (studio-theme.css).
//
// TEMPLATE-PRODUCT-1 §7.2 — a default of a FIXED_FORM document type opens the Studio's
// fixed-form mode (official PDF + fields placed by role); every other default the Studio.
export function DocumentTemplateDetailView({ session }: { readonly session: Session }) {
  const { id = '' } = useParams<{ id: string }>();
  const [mode, setMode] = useState<'loading' | 'fixed' | 'studio'>('loading');
  useEffect(() => {
    let live = true;
    setMode('loading');
    Promise.all([documentTemplatesApi.getTemplate(id), documentTemplatesApi.listDocumentTypes()])
      .then(([t, types]) => {
        const kind = types.document_types.find((d) => d.id === t.document_type_id)?.template_kind;
        if (live) setMode(kind === 'FIXED_FORM' ? 'fixed' : 'studio');
      })
      // The Studio owns the load-error UI: fall back to it.
      .catch(() => live && setMode('studio'));
    return () => {
      live = false;
    };
  }, [id]);
  if (mode === 'loading') return <div className="pw-loading" aria-busy="true" />;
  return mode === 'fixed' ? (
    <PlatformFixedFormStudio key={id} session={session} templateId={id} />
  ) : (
    <PlatformTemplateStudio key={id} session={session} templateId={id} />
  );
}

export function PlatformFixedFormStudio({ session, templateId }: { readonly session: Session; readonly templateId: string }) {
  const identity = useIdentity();
  const setEntity = useSetEntityCrumb();
  const dataSource = useMemo(() => platformFixedFormDataSource(session), [session]);
  return (
    <FixedFormStudio
      dataSource={dataSource}
      templateId={templateId}
      canManage={hasScope(session, DOC_TEMPLATE_MANAGE_SCOPE)}
      onEntityName={setEntity}
      formatError={templateErrorMessage}
      renderAccount={() => (
        <AccountMenu identity={identity} onSwitchAccount={() => redirectToLogin({ selectAccount: true })} onSignOut={() => void logout()} />
      )}
    />
  );
}

export function PlatformTemplateStudio({ session, templateId }: { readonly session: Session; readonly templateId: string }) {
  const identity = useIdentity();
  const setEntity = useSetEntityCrumb();
  const dataSource = useMemo(() => platformStudioDataSource(session), [session]);
  const renderAccount = useCallback(
    ({ notice, beforeLeave }: StudioAccountSlot) => (
      <AccountMenu
        identity={identity}
        onSwitchAccount={() => void beforeLeave(() => redirectToLogin({ selectAccount: true }))}
        onSignOut={() => void beforeLeave(() => void logout())}
        notice={notice}
      />
    ),
    [identity],
  );
  return (
    <TemplateStudio
      context="platform"
      dataSource={dataSource}
      templateId={templateId}
      renderAccount={renderAccount}
      onEntityName={setEntity}
      formatError={templateErrorMessage}
    />
  );
}
