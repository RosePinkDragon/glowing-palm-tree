import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { formatAccountPhone } from '@market/core';
import { MarketIcon } from './MarketIcons';
import { MarketSwitch } from './MarketSwitch';
import { MarketGroup, MarketRow } from './MarketList';
import { messageOf, type useMarket } from './useMarket';
import { useMarketFonts, useMarketTheme } from './theme';
import { ownerInitials } from './owner-navigation';
import { checkOwnerName, ownerNameChanged, isSaveLock, ownerNameProblem, OWNER_NAME_MAX, type SaveProblem } from './owner-name-model';

type Market = ReturnType<typeof useMarket>;

// "Your name" (#53): the name recorded on order history steps this owner makes. The server rule is the authority.
function OwnerNameSection({ services, saved, onSaved }: { services: Market['services']; saved: string | null; onSaved: (name: string) => void }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  const [value, setValue] = useState(saved ?? '');
  const [problem, setProblem] = useState<SaveProblem | null>(null);
  // Sticky: access or account changes lock Save until reload; editing the text never clears it.
  const [lock, setLock] = useState<SaveProblem | null>(null);
  const inputRef = useRef<ComponentRef<typeof TextInput> | null>(null);
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const body = (size = 15) => ({ color: colors.ink, fontSize: size, lineHeight: Math.round(size * 1.45), ...(fonts.body ? { fontFamily: fonts.body } : {}) });
  const bold = fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const };
  const fieldError = problem?.kind === 'invalid' ? problem.message : undefined;
  const banner = lock ?? (problem && problem.kind !== 'invalid' ? problem : null);
  const locked = lock !== null;
  const canSave = !saving && !locked && ownerNameChanged(value, saved);
  const edit = (text: string) => { if (busy.current) return; setValue(text); setProblem(null); setNotice(''); };
  const save = async () => {
    if (busy.current || locked) return;
    setNotice(''); setProblem(null);
    const checked = checkOwnerName(value);
    if (!checked.ok) { setProblem({ kind: 'invalid', message: checked.message }); setTimeout(() => inputRef.current?.focus(), 0); return; }
    if (!ownerNameChanged(value, saved)) return;
    busy.current = true; setSaving(true);
    try {
      const name = await services.setOwnerDisplayName(checked.name);
      if (!mounted.current) return;
      setValue(name); onSaved(name); setNotice('Your name is saved.');
    } catch (error) {
      if (mounted.current) {
        const next = ownerNameProblem(error);
        if (isSaveLock(next)) setLock(next); else setProblem(next);
        if (next.kind === 'invalid') setTimeout(() => inputRef.current?.focus(), 0);
      }
    }
    finally { busy.current = false; if (mounted.current) setSaving(false); }
  };
  const errorId = 'owner-name-error', hintId = 'owner-name-hint';
  return <View style={{ gap: 8 }}>
    <Text accessibilityRole="header" aria-level={2} style={{ color: colors.muted, fontSize: 12, lineHeight: 16, letterSpacing: 1.2, textTransform: 'uppercase', ...bold }}>Your name</Text>
    <View style={{ backgroundColor: colors.surface, borderRadius: 16, borderWidth: 1, borderColor: colors.border, padding: 16, gap: 12 }}>
      <Text nativeID="owner-name-label" style={{ ...body(15), ...bold }}>Name shown to your team</Text>
      <TextInput ref={inputRef} value={value} onChangeText={edit} onSubmitEditing={() => void save()} blurOnSubmit={false} maxLength={OWNER_NAME_MAX * 2}
        accessibilityLabel="Name shown to your team" aria-labelledby="owner-name-label" aria-invalid={fieldError ? true : undefined} aria-describedby={fieldError ? `${errorId} ${hintId}` : hintId}
        autoComplete="name" autoCorrect={false} returnKeyType="done"
        style={{ minHeight: 52, borderWidth: fieldError ? 2 : 1, borderColor: fieldError ? colors.danger : colors.inputBorder, borderRadius: 14, backgroundColor: colors.surface, paddingHorizontal: 14, color: colors.ink, fontSize: 16, ...(fonts.body ? { fontFamily: fonts.body } : {}), ...({ outlineStyle: 'none' } as object) }} />
      {fieldError ? <Text nativeID={errorId} role="alert" accessibilityRole="alert" style={{ ...body(14), color: colors.danger }}>{fieldError}</Text> : null}
      <Text nativeID={hintId} style={{ ...body(13), color: colors.muted }}>Recorded on the order history steps you make. Earlier steps keep the name used at the time.</Text>
      {banner ? <View role="alert" accessibilityRole="alert" style={{ padding: 12, borderRadius: 12, backgroundColor: colors.warningTint }}><Text style={{ ...body(14), color: colors.warning, ...bold }}>{banner.message}</Text></View> : null}
      {notice ? <Text role="status" accessibilityRole="text" accessibilityLiveRegion="polite" style={{ ...body(14), color: colors.positive, ...bold }}>{notice}</Text> : null}
      <Pressable accessibilityRole="button" accessibilityLabel={saving ? 'Saving name' : 'Save name'} accessibilityState={{ disabled: !canSave, busy: saving }} aria-busy={saving} disabled={!canSave} onPress={() => void save()}
        style={({ pressed }) => ({ minHeight: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary, opacity: !canSave ? 0.5 : pressed ? 0.85 : 1 })}>
        <Text style={{ color: colors.onPrimary, fontSize: 16, ...bold }}>{saving ? 'Saving…' : 'Save name'}</Text>
      </Pressable>
    </View>
  </View>;
}

// Owners' Settings (owners' screen p. 10). Restaurant details (#60) opens its screen; Owners (#59) and the
// ring and test-alert controls (#54) are announced as coming soon and are not interactive.
export function OwnerSettings({ market, onOpenRestaurantDetails, onOpenOffers }: { market?: Market; onOpenRestaurantDetails?: () => void; onOpenOffers?: () => void }) {
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

  const contact = formatAccountPhone(session.user.phone) ?? session.user.email ?? 'Signed in';
  const displayName = ownerName ?? contact;
  const loadingName = ownerName === undefined;
  const switchRow = (title: string, detail: string, value: boolean, onChange: (next: boolean) => void) =>
    <MarketRow roomy title={title} detail={detail} end={<MarketSwitch label={title} hint={detail} value={value} disabled={!settings.ready} busy={settings.busy} onValueChange={onChange} />} />;

  return <View style={{ gap: 24 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16, padding: 20, backgroundColor: colors.surface, borderRadius: 20, borderWidth: 1, borderColor: colors.border }}>
      <View aria-hidden style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center' }}>
        {loadingName ? null : <Text style={{ color: colors.onPrimary, fontSize: 22, ...bold }}>{ownerInitials(displayName)}</Text>}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        {loadingName ? <View aria-label="Loading your name" role="progressbar" style={{ gap: 6 }}><View style={{ width: 140, height: 16, borderRadius: 8, backgroundColor: colors.border }} /><View style={{ width: 100, height: 12, borderRadius: 6, backgroundColor: colors.border }} /></View> : <>
        <Text accessibilityRole="header" aria-level={2} style={{ ...body(19), ...bold }}>{displayName}</Text>
        <Text style={muted}>{ownerName ? `${contact} · Owner` : 'Owner'}</Text></>}
      </View>
    </View>
    {loadingName ? null : <OwnerNameSection key={session.user.id} services={market.services} saved={ownerName ?? null} onSaved={setOwnerName} />}
    {!market.services.persistenceAvailable() ? <Text style={muted}>This session is stored only for this visit because device storage is unavailable.</Text> : null}
    <MarketGroup inset title="Restaurant">
      {onOpenRestaurantDetails
        ? <Pressable accessibilityRole="button" accessibilityLabel="Restaurant details" accessibilityHint="Phone numbers, delivery fee, minimum order" onPress={onOpenRestaurantDetails} style={({ pressed }) => ({ backgroundColor: pressed ? colors.tint : 'transparent' })}>
          <MarketRow roomy title="Restaurant details" detail="Phone numbers, delivery fee, minimum order" end={<MarketIcon name="chevronRight" color={colors.muted} />} />
        </Pressable>
        : <MarketRow roomy title="Restaurant details" detail="Phone numbers, delivery fee, minimum order" end={soon} />}
      {onOpenOffers ? <Pressable accessibilityRole="button" accessibilityLabel="Offers" accessibilityHint="Discounts and codes for customers" onPress={onOpenOffers} style={({ pressed }) => ({ backgroundColor: pressed ? colors.tint : 'transparent' })}>
          <MarketRow roomy title="Offers" detail="Discounts and codes for customers" end={<MarketIcon name="chevronRight" color={colors.muted} />} />
        </Pressable> : null}
      <MarketRow roomy title="Owners" detail={`Who can manage ${name}`} end={soon} />
    </MarketGroup>
    <MarketGroup inset title="New order alerts on this phone">
      {switchRow('Notifications', 'Even when the app is closed', settings.prefs.push, next => settings.setPush(next))}
      <MarketRow roomy title="Ring for new orders" detail="Loud sound until someone opens it" end={soon} />
      <MarketRow roomy title="Play a test alert" end={soon} />
    </MarketGroup>
    {status(settings.pushMessage)}
    <MarketGroup inset title="Privacy">{switchRow('Share app usage', 'Anonymous usage, speed and error reports that help us improve the app', settings.prefs.analytics, next => void settings.setAnalytics(next))}</MarketGroup>
    {status(settings.analyticsMessage)}
    <Pressable accessibilityRole="button" disabled={settings.busy} onPress={() => { setSignOutError(''); void settings.signOut().catch(e => setSignOutError(messageOf(e))); }}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 56, borderRadius: 20, borderWidth: 1, borderColor: colors.border, backgroundColor: pressed ? colors.tint : colors.surface, opacity: settings.busy ? 0.6 : 1 })}>
      <MarketIcon name="logout" color={colors.ink} />
      <Text style={{ ...body(15), ...bold }}>Log out</Text>
    </Pressable>
    {signOutError ? <Text role="alert" accessibilityRole="alert" style={{ ...body(14), color: colors.danger }}>{signOutError}</Text> : null}
    <Text style={{ ...muted, textAlign: 'center' }}>{`${name} owners' app`}</Text>
  </View>;
}
