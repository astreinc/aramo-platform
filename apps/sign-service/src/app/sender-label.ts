// Aramo-Sign-Mobile-Amendment-M-A13-Field-Test-Remediation-v1_0-LOCKED R-3 — the sender
// label a recipient sees ("From …"). A BUSINESS tenant shows its organization name (branding
// display_name, else the workspace name), as before. A PERSONAL tenant shows the sender's own
// display name: its stored name carries a uniqueness suffix ("<name> (Personal xxxxxxxx)")
// that never appears on a user-visible surface. Display only — nothing stored is renamed.
//
// The plain display name is used (not personalWorkspaceLabel's "<name> — Personal"): the
// recipient is told who sent the document, not the sender's account type.

export interface SenderLabelSources {
  findTenantNameById(tenant_id: string): Promise<{ name: string; display_name: string | null; kind?: string } | null>;
  findUserById(user_id: string): Promise<{ display_name?: string | null } | null>;
}

export async function recipientSenderLabel(identity: SenderLabelSources, tenant_id: string, created_by: string | null): Promise<string | null> {
  const tenant = await identity.findTenantNameById(tenant_id).catch(() => null);
  if (tenant === null) return null;
  if (tenant.kind === 'PERSONAL') {
    if (created_by === null) return null;
    const user = await identity.findUserById(created_by).catch(() => null);
    const name = (user?.display_name ?? '').trim();
    return name.length > 0 ? name : null;
  }
  const display = (tenant.display_name ?? '').trim();
  return display.length > 0 ? display : tenant.name;
}
