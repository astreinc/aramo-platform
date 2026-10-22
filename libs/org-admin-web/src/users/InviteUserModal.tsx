// ORG-UX-1 (handoff §6.3) — the Invite user modal, shared by Users & invitations, Overview
// and App Home's Shortcuts ("opens the invite form in place"). CONTRACT (implemented in
// I-7 by the Users work).
export interface InviteUserModalProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Called after a successful invitation (the caller refreshes its data). */
  readonly onInvited?: () => void;
}

export function InviteUserModal(_props: InviteUserModalProps) {
  return null;
}
