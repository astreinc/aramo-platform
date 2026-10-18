import { IconBriefcase, IconBuilding, IconDesk, IconPencil } from '../ui/icons';
import type { AppSwitcherItem } from '../ui/AppSwitcher';

import { productByKey, productEntryHref, type ProductAvailability, type ProductAvailabilityView } from './products';

// The app-switcher rows for every Aramo app on the tenant host, built from the
// backend-authoritative availability read. App Home is always present (it is
// not a product and needs no subscription); Organization appears only when the
// backend says the caller may administer it. The external signer app is never a
// row (it is reached only through a signing link for one recipient).

export type AramoAppKey = 'home' | 'ats' | 'sign' | 'org';

const HOME_PATH = '/';
const ORG_PATH = '/org/';

function unavailableSub(p: ProductAvailability | null): string {
  if (p === null) return 'Unavailable right now';
  if (!p.subscribed) return 'Not part of your plan';
  if (!p.authorized) return 'No access';
  return 'Not available yet';
}

/**
 * @param current the app rendering the switcher.
 * @param inHomeApp true when the caller is App Home / Organization (one SPA), so
 *        those two rows use router links instead of full navigation.
 */
export function buildAppSwitcherItems(args: {
  readonly current: AramoAppKey;
  readonly products: ProductAvailabilityView | null;
}): AppSwitcherItem[] {
  const { current, products } = args;
  const inHomeApp = current === 'home' || current === 'org';
  const link = (path: string): { to?: string; href?: string } => (inHomeApp ? { to: path } : { href: path });
  const items: AppSwitcherItem[] = [
    {
      key: 'home',
      label: 'App Home',
      sub: current === 'home' ? 'You are here' : 'Your apps and organization',
      icon: <IconDesk />,
      state: current === 'home' ? 'current' : 'open',
      ...link(HOME_PATH),
    },
  ];
  for (const [key, productKey] of [
    ['ats', 'ats'],
    ['sign', 'esign'],
  ] as const) {
    const p = productByKey(products, productKey);
    const label = key === 'ats' ? 'Aramo ATS' : 'Aramo Sign';
    const icon = key === 'ats' ? <IconBriefcase /> : <IconPencil />;
    if (current === key) {
      items.push({ key, label, sub: 'You are here', icon, state: 'current', href: p?.entry_path ?? '#' });
      continue;
    }
    const href = p === null ? null : productEntryHref(p);
    items.push(
      href === null
        ? { key, label, sub: unavailableSub(p), icon, state: 'unavailable' }
        : { key, label, sub: 'Opens if available to you', icon, state: 'open', href },
    );
  }
  const org = productByKey(products, 'org');
  if (current === 'org' || (org !== null && org.available)) {
    items.push({
      key: 'org',
      label: 'Organization',
      sub: current === 'org' ? 'You are here' : 'Admin · shared by all apps',
      icon: <IconBuilding />,
      state: current === 'org' ? 'current' : 'open',
      ...link(ORG_PATH),
    });
  }
  return items;
}
