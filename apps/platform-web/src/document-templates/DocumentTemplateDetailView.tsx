import { useCallback, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { logout, redirectToLogin, type Session } from '@aramo/fe-foundation';
import { TemplateStudio, type StudioAccountSlot } from '@aramo/document-templates-web';

import { useIdentity } from '../identity/identity';
import { AccountMenu } from '../shell/AccountMenu';
import { useSetEntityCrumb } from '../shell/crumbs';

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
export function DocumentTemplateDetailView({ session }: { readonly session: Session }) {
  const { id = '' } = useParams<{ id: string }>();
  return <PlatformTemplateStudio key={id} session={session} templateId={id} />;
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
