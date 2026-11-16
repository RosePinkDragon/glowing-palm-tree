import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { MarketSwitch } from './MarketSwitch';
import { messageOf, type useMarket } from './useMarket';
import { useMarketFonts, useMarketTheme } from './theme';
import { ownerInitials } from './owner-navigation';

type Market = ReturnType<typeof useMarket>;

// Owners' Settings (owners' screen p. 10). Restaurant details (#60), Owners (#59) and the ring
// and test-alert controls (#54) are announced as coming soon and are not interactive.
export function OwnerSettings({ market }: { market?: Market }) {
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
  const section = (title: string, children: ReactNode) => <View style={{ gap: 8 }}>
    <Text accessibilityRole="header" aria-level={2} style={{ ...muted, ...bold, letterSpacing: 1.2 }}>{title.toUpperCase()}</Text>
    <View style={{ backgroundColor: colors.surface, borderRadius: 16, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' }}>{children}</View>
  </View>;
  const row = (key: string, title: string, detail: string | undefined, end?: ReactNode, last = false) => <View key={key} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: last ? 0 : 1, borderBottomColor: colors.border }}>
    <View style={{ flex: 1, gap: 2 }}>
      <Text style={{ ...body(15), ...bold }}>{title}</Text>
      {detail ? <Text style={muted}>{detail}</Text> : null}
    </View>
    {end}
  </View>;
  const soon = <Text style={{ ...muted, ...bold }}>Coming soon</Text>;
  const status = (message: string | undefined) => message ? <Text role="status" accessibilityLiveRegion="polite" style={{ ...muted, paddingHorizontal: 4 }}>{message}</Text> : null;

  if (!market || !session || !settings) return <View style={{ gap: 20 }}>
    {section('Your account', row('sample', 'Sign-in is not available in sample mode.', undefined, undefined, true))}
    <Text style={{ ...muted, textAlign: 'center' }}>{`${name} owners' app`}</Text>
  </View>;

  const contact = session.user.phone ? `+${session.user.phone}` : session.user.email ?? 'Signed in';
  const displayName = ownerName ?? contact;
  const loadingName = ownerName === undefined;
  const switchRow = (key: string, title: string, detail: string, value: boolean, onChange: (next: boolean) => void, last = false) =>
    row(key, title, detail, <MarketSwitch label={title} hint={detail} value={value} disabled={!settings.ready} busy={settings.busy} onValueChange={onChange} />, last);

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
    {section('Restaurant', <>
      {row('details', 'Restaurant details', 'Phone numbers, delivery fee, minimum order', soon)}
      {row('owners', 'Owners', `Who can manage ${name}`, soon, true)}
    </>)}
    {section('New order alerts on this phone', <>
      {switchRow('push', 'Notifications', 'Even when the app is closed', settings.prefs.push, next => settings.setPush(next))}
      {row('ring', 'Ring for new orders', 'Loud sound until someone opens it', soon)}
      {row('test', 'Play a test alert', undefined, soon, true)}
    </>)}
    {status(settings.pushMessage)}
    {section('Privacy', switchRow('analytics', 'Share app usage', 'Anonymous data that helps us improve the app', settings.prefs.analytics, next => void settings.setAnalytics(next), true))}
    {status(settings.analyticsMessage)}
    <Pressable accessibilityRole="button" disabled={settings.busy} onPress={() => { setSignOutError(''); void settings.signOut().catch(e => setSignOutError(messageOf(e))); }}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 52, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: pressed ? colors.tint : colors.surface, opacity: settings.busy ? 0.6 : 1 })}>
      <Svg aria-hidden accessible={false} width={18} height={18} viewBox="0 0 24 24"><Path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" fill="none" stroke={colors.ink} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /></Svg>
      <Text style={{ ...body(15), ...bold }}>Log out</Text>
    </Pressable>
    {signOutError ? <Text role="alert" accessibilityRole="alert" style={{ ...body(14), color: colors.danger }}>{signOutError}</Text> : null}
    <Text style={{ ...muted, textAlign: 'center' }}>{`${name} owners' app`}</Text>
  </View>;
}
