// M-A12 W1-G — Plans (prototype "Upgrade your plan"), entered from the Home banner,
// Templates, Account › Plan and allowance refusals. Tabs come only from the server's
// plans (filtered to the tenant kind); prices only from the store; the purchase only
// through the platform store (D-3), never an external purchase link or web checkout.
// See features/plans/plansModel.ts for the rules.
import { useRoute, type RouteProp } from '@react-navigation/native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { StoreInterval, StorePlatform } from '../../api/m-a12-contract-types';
import { useServices } from '../../app/ServicesContext';
import { OfflineBanner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { useToast } from '../../components/Toast';
import { FEATURES } from '../../config/features';
import { WEB_LINKS } from '../../config/env';
import { allowanceModel, limitBanner } from '../../features/inbox/allowance';
import { signKeys, useBillingAccount, useOnline } from '../../features/inbox/queries';
import { Segments } from '../../features/inbox/ui';
import {
  businessWebLinks,
  featureLines,
  initialPlanKey,
  intervalLabel,
  intervals,
  isBusinessAccount,
  isCurrent,
  perInterval,
  planAction,
  PLANS_COPY,
  productFor,
  reasonLine,
  showIntervalToggle,
  STORE_NOTE,
  storeBillingAvailable,
  visiblePlans,
  type Account,
  type Plan,
} from '../../features/plans/plansModel';
import { buy, createStoreBillingApi, restore } from '../../features/plans/purchaseFlow';
import type { StoreProductInfo } from '../../features/plans/storePort';
import type { PlansEntry, RootStackParamList } from '../../navigation/types';
import { useTheme } from '../../theme';

export const plansKey = ['sign', 'billing', 'plans'] as const;

function open(url: string): void {
  void WebBrowser.openBrowserAsync(url).catch(() => undefined);
}

export function PlansScreen() {
  const route = useRoute<RouteProp<RootStackParamList, 'Plans'>>();
  const { workspace, iap } = useServices();
  const qc = useQueryClient();
  const toast = useToast();
  const online = useOnline();
  const billing = useBillingAccount();
  const api = useMemo(() => createStoreBillingApi(workspace), [workspace]);
  const plans = useQuery({ queryKey: plansKey, queryFn: () => api.plans() });
  const store = FEATURES.storePurchase ? (iap ?? null) : null;
  const account = (billing.data ?? null) as Account | null;
  const list = visiblePlans(plans.data ?? []);
  const storeOn = !!store && storeBillingAvailable(account, list);
  const [products, setProducts] = useState<Record<string, StoreProductInfo>>({});
  const [busy, setBusy] = useState<'buy' | 'restore' | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const productIds = useMemo(
    () =>
      store
        ? list.flatMap((p) => (p.store_products ?? []).filter((x) => x.platform === store.platform).map((x) => x.product_id))
        : [],
    [list, store],
  );
  const idsKey = productIds.join('|');
  useEffect(() => {
    if (!store || !storeOn || idsKey === '') return undefined;
    let live = true;
    void (async () => {
      if (!(await store.connect())) return;
      const found = await store.products(idsKey.split('|')).catch(() => []);
      if (live) setProducts(Object.fromEntries(found.map((p) => [p.productId, p])));
    })();
    return () => {
      live = false;
    };
  }, [store, storeOn, idsKey]);
  useEffect(() => () => void store?.disconnect(), [store]);

  async function onBuy(product: StoreProductInfo): Promise<void> {
    if (!store) return;
    setBusy('buy');
    setMessage(null);
    const r = await buy({ store, api }, product);
    setBusy(null);
    if (r.kind === 'purchased') {
      qc.setQueryData(signKeys.billing, r.account);
      void qc.invalidateQueries({ queryKey: signKeys.billing });
      void qc.invalidateQueries({ queryKey: signKeys.context });
      toast.show('Your plan is updated');
    } else if (r.kind !== 'cancelled') setMessage(r.message);
  }

  async function onRestore(): Promise<void> {
    if (!store) return;
    setBusy('restore');
    setMessage(null);
    await store.connect();
    const r = await restore({ store, api });
    setBusy(null);
    if (r.kind === 'restored') {
      qc.setQueryData(signKeys.billing, r.account);
      void qc.invalidateQueries({ queryKey: signKeys.billing });
      toast.show(PLANS_COPY.restored);
    } else setMessage(r.kind === 'none' ? PLANS_COPY.nothingToRestore : r.message);
  }

  if ((plans.isPending || billing.isPending) && !plans.data) {
    return (
      <View style={styles.center}>
        <ActivityIndicator accessibilityLabel="Loading plans" />
      </View>
    );
  }

  return (
    <PlansView
      plans={list}
      account={account}
      platform={store?.platform ?? null}
      storeOn={storeOn}
      products={products}
      from={route.params?.from}
      online={online}
      busy={busy}
      message={message}
      onBuy={(p) => void onBuy(p)}
      onRestore={() => void onRestore()}
      onManage={(productId) => void store?.manageSubscriptions(productId).catch(() => undefined)}
    />
  );
}

export function PlansView({
  plans,
  account,
  platform,
  storeOn,
  products,
  from,
  online,
  busy,
  message,
  onBuy,
  onRestore,
  onManage,
}: {
  readonly plans: readonly Plan[];
  readonly account: Account | null;
  /** The store's platform, or null when no store is available on this device. */
  readonly platform: StorePlatform | null;
  readonly storeOn: boolean;
  readonly products: Readonly<Record<string, StoreProductInfo>>;
  readonly from?: PlansEntry;
  readonly online: boolean;
  readonly busy: 'buy' | 'restore' | null;
  readonly message: string | null;
  readonly onBuy: (p: StoreProductInfo) => void;
  readonly onRestore: () => void;
  readonly onManage: (productId?: string) => void;
}) {
  const t = useTheme();
  const [planKey, setPlanKey] = useState<string | null>(() => initialPlanKey(plans, account));
  const plan = plans.find((p) => p.key === planKey) ?? plans[0] ?? null;
  const avail = plan && platform ? intervals(plan, platform) : [];
  const [period, setPeriod] = useState<StoreInterval>('YEAR');
  const chosen: StoreInterval = avail.includes(period) ? period : (avail[0] ?? 'YEAR');
  const product = plan && platform && storeOn ? productFor(plan, platform, chosen) : null;
  const info = product ? (products[product.product_id] ?? null) : null;
  const action = plan
    ? planAction({ plan, account, storeOn, product, priced: info !== null })
    : { kind: 'none' as const, message: null };
  const limit = limitBanner(allowanceModel(account));
  const personal = account?.tenant_kind === 'PERSONAL';
  // PO 2026-11-13 — a Business admin finishes users, roles and access and chooses the plan on the web.
  const businessWeb = businessWebLinks(account);
  const business = isBusinessAccount(account);
  const storeManaged =
    (platform === 'ios' && account?.managed_by === 'APP_STORE') ||
    (platform === 'android' && account?.managed_by === 'GOOGLE_PLAY');
  const text = { color: t.color.text, fontFamily: t.font.family };
  const secondary = { color: t.color.textSecondary, fontFamily: t.font.family };

  if (!plan) {
    return (
      <View style={[styles.center, { backgroundColor: t.color.screen }]} testID="plans-empty">
        <Text style={secondary}>{PLANS_COPY.manageOnWeb}</Text>
      </View>
    );
  }

  return (
    <ScrollView testID="plans-screen" style={{ flex: 1, backgroundColor: t.color.screen }} contentContainerStyle={styles.body}>
      {!online ? <OfflineBanner /> : null}
      <Text accessibilityRole="header" style={[text, { fontSize: 26, fontWeight: '700' }]}>
        Upgrade your plan
      </Text>
      <Text testID="plans-reason" style={[secondary, { fontSize: 15, lineHeight: 21 }]}>
        {reasonLine(from, plans, limit?.body ?? null)}
      </Text>
      {plans.length > 1 ? (
        <Segments
          items={plans.map((p) => ({ key: p.key, label: p.name }))}
          value={plan.key}
          onChange={setPlanKey}
          testIDPrefix="plan-tab"
        />
      ) : null}
      <Card style={styles.card}>
        <View style={styles.titleRow}>
          <Text testID="plan-name" style={[text, { fontSize: 22, fontWeight: '700', flex: 1 }]}>
            {plan.name}
          </Text>
          {isCurrent(plan, account) ? (
            <Text testID="plan-current" style={{ color: t.color.success, fontWeight: '600' }}>
              {PLANS_COPY.current}
            </Text>
          ) : null}
        </View>
        {plan.description ? <Text style={[secondary, { fontSize: 15 }]}>{plan.description}</Text> : null}
        {featureLines(plan).map((line) => (
          <Text key={line} style={[text, { fontSize: 15 }]}>{`✓  ${line}`}</Text>
        ))}
        {storeOn && platform && showIntervalToggle(plan, platform) ? (
          <Segments
            items={avail.map((i) => ({ key: i, label: intervalLabel(i) }))}
            value={chosen}
            onChange={(k) => setPeriod(k as StoreInterval)}
            testIDPrefix="plan-interval"
          />
        ) : null}
        {storeOn && info ? (
          <View style={styles.price}>
            <Text testID="plan-price" style={[text, { fontSize: 30, fontWeight: '700' }]}>
              {info.displayPrice}
            </Text>
            <Text style={[secondary, { fontSize: 15 }]}>{perInterval(chosen, plan)}</Text>
          </View>
        ) : null}
        {action.kind === 'buy' && info ? (
          <Button
            testID="plan-continue"
            title={`Continue with ${plan.name}`}
            busy={busy === 'buy'}
            disabled={!online || busy !== null}
            onPress={() => onBuy(info)}
          />
        ) : action.message ? (
          <Text testID="plan-blocked" style={[secondary, { fontSize: 15, lineHeight: 21 }]}>
            {action.message}
          </Text>
        ) : null}
        {message ? (
          <Text testID="plans-message" accessibilityRole="alert" style={{ color: t.color.textSecondary, fontSize: 14 }}>
            {message}
          </Text>
        ) : null}
      </Card>
      {businessWeb ? (
        <View testID="plans-business-web">
        <Card style={styles.card}>
          <Text testID="plans-business-message" style={[text, { fontSize: 15, lineHeight: 21 }]}>
            {businessWeb.message}
          </Text>
          <Button
            testID="plans-business-plan"
            title={businessWeb.plan.label}
            disabled={!online}
            onPress={() => open(businessWeb.plan.url)}
          />
          <Button
            testID="plans-business-members"
            title={businessWeb.members.label}
            variant="text"
            disabled={!online}
            onPress={() => open(businessWeb.members.url)}
          />
        </Card>
        </View>
      ) : null}
      {storeOn && platform && !business ? (
        <>
          <Text testID="store-note" style={[secondary, { fontSize: 13, lineHeight: 18 }]}>
            {STORE_NOTE[platform]}
          </Text>
          <View style={styles.links}>
            <Pressable
              testID="plans-terms"
              accessibilityRole="link"
              onPress={() => open(personal ? WEB_LINKS.personalTerms : WEB_LINKS.terms)}
            >
              <Text style={{ color: t.color.accent, fontSize: 14 }}>Terms</Text>
            </Pressable>
            <Pressable testID="plans-privacy" accessibilityRole="link" onPress={() => open(WEB_LINKS.privacy)}>
              <Text style={{ color: t.color.accent, fontSize: 14 }}>Privacy</Text>
            </Pressable>
          </View>
          <Button
            testID="plans-restore"
            title="Restore purchases"
            variant="text"
            busy={busy === 'restore'}
            disabled={!online || busy !== null}
            onPress={onRestore}
          />
          {storeManaged ? (
            <Button
              testID="plans-manage"
              title="Manage subscription"
              variant="text"
              onPress={() => onManage(product?.product_id)}
            />
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  body: { padding: 16, gap: 14, paddingBottom: 48 },
  card: { padding: 16, gap: 10 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  price: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  links: { flexDirection: 'row', gap: 20 },
});
