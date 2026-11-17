import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { MarketIcon } from './MarketIcons';
import { MarketSwitch } from './MarketSwitch';
import { MarketGroup, MarketRow } from './MarketList';
import { messageOf, type useMarket } from './useMarket';
import { useMarketFonts, useMarketTheme } from './theme';
import { ownerInitials } from './owner-navigation';

type Market = ReturnType<typeof useMarket>;

// Owners' Settings (owners' screen p. 10). Restaurant details (#60) opens its screen; Owners (#59) and the
// ring and test-alert controls (#54) are announced as coming soon and are not interactive.
export function OwnerSettings({ market, onOpenRestaurantDetails }: { market?: Market; onOpenRestaurantDetails?: () => void }) {
  const { colors, name } = useMarketTheme();
  const fonts = useMarketFonts();
  // undefined while loading, so the card never flashes the contact before the name arrives.
  const [ownerName, setOwnerName] = useState<string | null | undefined>(undefined);
  const [signOutError, setSignOutError] = useState('');
  const session = market?.session;
  const settings = market?.preferences;
  useEffect(() => {
    if (!market || !session) return;
    let active = true;
    setOwnerName(undefined);
    // A missing name is not an error: fall back to the account identifier.
    market.services.getOwnerDisplayName().then(value => { if (active) setOwnerName(value); }, () => { if (active) setOwnerName(null); });
    return () => { active = false; };
  }, [market?.services, session?.user.id]);

  const body = (size = 15) => ({ color: colors.ink, fontSize: size, lineHeight: Math.round(size * 1.45), ...(fonts.body ? { fontFamily: fonts.body } : {}) });
  const bold = fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const };
  const muted = { ...body(13), color: colors.muted };
  const soon = <Text style={{ ...muted, ...bold }}>Coming soon</Text>;
  const status = (message: string | undefined) => message ? <Text role="status" accessibilityLiveRegion="polite" style={{ ...muted, paddingHorizontal: 4 }}>{message}</Text> : null;

  if (!market || !session || !settings) return <View style={{ gap: 20 }}>
    <MarketGroup title="Your account"><MarketRow title="Sign-in is not available in sample mode." /></MarketGroup>
    <Text style={{ ...muted, textAlign: 'center' }}>{`${name} owners' app`}</Text>
  </View>;

  const contact = session.user.phone ? `+${session.user.phone}` : session.user.email ?? 'Signed in';
  const displayName = ownerName ?? contact;
  const loadingName = ownerName === undefined;
  const switchRow = (title: string, detail: string, value: boolean, onChange: (next: boolean) => void) =>
    <MarketRow title={title} detail={detail} end={<MarketSwitch label={title} hint={detail} value={value} disabled={!settings.ready} busy={settings.busy} onValueChange={onChange} />} />;

  return <View style={{ gap: 20 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, backgroundColor: colors.surface, borderRadius: 16, borderWidth: 1, borderColor: colors.border }}>
      <View aria-hidden style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center' }}>
        {loadingName ? null : <Text style={{ color: colors.onPrimary, fontSize: 16, ...bold }}>{ownerInitials(displayName)}</Text>}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        {loadingName ? <View aria-label="Loading your name" role="progressbar" style={{ gap: 6 }}><View style={{ width: 140, height: 16, borderRadius: 8, backgroundColor: colors.border }} /><View style={{ width: 100, height: 12, borderRadius: 6, backgroundColor: colors.border }} /></View> : <>
        <Text accessibilityRole="header" aria-level={2} style={{ ...body(17), ...bold }}>{displayName}</Text>
        <Text style={muted}>{ownerName ? `${contact} · Owner` : 'Owner'}</Text></>}
      </View>
    </View>
    {!market.services.persistenceAvailable() ? <Text style={muted}>This session is stored only for this visit because device storage is unavailable.</Text> : null}
    <MarketGroup title="Restaurant">
      {onOpenRestaurantDetails
        ? <Pressable accessibilityRole="button" accessibilityLabel="Restaurant details" accessibilityHint="Phone numbers, delivery fee, minimum order" onPress={onOpenRestaurantDetails} style={({ pressed }) => ({ backgroundColor: pressed ? colors.tint : 'transparent' })}>
          <MarketRow title="Restaurant details" detail="Phone numbers, delivery fee, minimum order" end={<MarketIcon name="chevronRight" color={colors.muted} />} />
        </Pressable>
        : <MarketRow title="Restaurant details" detail="Phone numbers, delivery fee, minimum order" end={soon} />}
      <MarketRow title="Owners" detail={`Who can manage ${name}`} end={soon} />
    </MarketGroup>
    <MarketGroup title="New order alerts on this phone">
      {switchRow('Notifications', 'Even when the app is closed', settings.prefs.push, next => settings.setPush(next))}
      <MarketRow title="Ring for new orders" detail="Loud sound until someone opens it" end={soon} />
      <MarketRow title="Play a test alert" end={soon} />
    </MarketGroup>
    {status(settings.pushMessage)}
    <MarketGroup title="Privacy">{switchRow('Share app usage', 'Anonymous data that helps us improve the app', settings.prefs.analytics, next => void settings.setAnalytics(next))}</MarketGroup>
    {status(settings.analyticsMessage)}
    <Pressable accessibilityRole="button" disabled={settings.busy} onPress={() => { setSignOutError(''); void settings.signOut().catch(e => setSignOutError(messageOf(e))); }}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 52, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: pressed ? colors.tint : colors.surface, opacity: settings.busy ? 0.6 : 1 })}>
      <MarketIcon name="logout" color={colors.ink} />
      <Text style={{ ...body(15), ...bold }}>Log out</Text>
    </Pressable>
    {signOutError ? <Text role="alert" accessibilityRole="alert" style={{ ...body(14), color: colors.danger }}>{signOutError}</Text> : null}
    <Text style={{ ...muted, textAlign: 'center' }}>{`${name} owners' app`}</Text>
  </View>;
}
