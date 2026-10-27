// "Search agreements" from the shared top bar (M-A4 §1.2). On Home the search pill is a
// button: it calls requestSearchFocus() and switches to the Agreements tab. Agreements
// calls consumeSearchFocus() when it gains focus and, when it returns true, focuses its
// search field. A pending flag (not an event) so the request survives the Agreements
// tab mounting for the first time.
let pending = false;

export function requestSearchFocus(): void {
  pending = true;
}

/** True once per request. */
export function consumeSearchFocus(): boolean {
  const was = pending;
  pending = false;
  return was;
}
