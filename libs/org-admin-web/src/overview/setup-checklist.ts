// ORG-UX-1 (handoff §6.1 / §5) — the organization setup checklist, shared by Overview and
// App Home's "Your organization" card. CONTRACT (implemented in I-7 by the Overview work):
//   1. Complete the organization profile — country is saved.
//   2. Verify your email domain — domain verified.
//   3. Invite your team — more than one person.
//   4. Add your sites — at least one site.
//   5. Approve a document template — an approved TENANT template exists (a grandfathered
//      Aramo-default selection does not count — directive §8.9).
export type SetupItemKey = 'profile' | 'domain' | 'team' | 'sites' | 'template';

export interface SetupItem {
  readonly key: SetupItemKey;
  readonly label: string;
  readonly hint: string;
  readonly done: boolean;
  /** Where Finish / View goes. */
  readonly path: string;
}

export type SetupChecklistState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly items: readonly SetupItem[]; readonly done: number; readonly total: number }
  | { readonly status: 'error' };

export function useSetupChecklist(): SetupChecklistState {
  return { status: 'loading' };
}
