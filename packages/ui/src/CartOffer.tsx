import { useEffect, useState } from 'react';
import { formatINRFromPaise } from '@market/core';
import { Pressable, Text, View } from 'react-native';
import type { ActiveOffer, OfferNudge, PricingTerms } from '@market/services';
import { MarketButton, MarketField } from './components';
import { MarketIcon } from './MarketIcons';
import { bannerText, nudgeText } from './offer-model';
import { useMarketFonts, useMarketTheme } from './theme';

/** A small strip with the restaurant's active automatic offer, for signed-out visitors (top of the menu and in the cart). */
export function OfferBanner({ offers }: { offers: readonly ActiveOffer[] }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  const text = bannerText(offers);
  if (!text) return null;
  return <View role="status" accessibilityLabel={`Offer: ${text}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingHorizontal: 14, borderRadius: 14, backgroundColor: colors.tint, borderWidth: 1, borderColor: colors.border }}>
    <MarketIcon name="check" color={colors.primary} size={16} />
    <Text style={{ flex: 1, color: colors.ink, fontSize: 15, lineHeight: 22, ...(fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const }) }}>{text}</Text>
  </View>;
}

export type CartOfferProps = {
  signedIn: boolean; offers: readonly ActiveOffer[]; pricing: PricingTerms | null; nudge: OfferNudge | null;
  code: string | null; message: string; applying: boolean; disabled: boolean;
  onApply: (code: string) => void; onRemove: () => void; onSignIn: () => void;
};

/**
 * The cart's offer row (#182): the offer that applies with its saving, a removable code, a "Have a code?" entry, the server's nudge
 * and the reason a code was refused. Signed out: the banner and "Sign in to apply", with no code entry. Presentation only: the server prices.
 */
export function CartOffer(p: CartOfferProps) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  const [open, setOpen] = useState(false), [entry, setEntry] = useState('');
  useEffect(() => { if (p.code) { setOpen(false); setEntry(''); } }, [p.code]);
  const bold = fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const };
  const body = { color: colors.ink, fontSize: 15, lineHeight: 22 };
  const applied = p.signedIn ? p.pricing?.offer : undefined;
  const link = (label: string, onPress: () => void, name = label) => <Pressable accessibilityRole="button" accessibilityLabel={name} disabled={p.disabled} onPress={onPress} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={{ color: colors.primary, fontSize: 15, ...bold }}>{label}</Text></Pressable>;
  const card = { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 20, padding: 16, gap: 8 };
  if (!p.signedIn) {
    if (!p.offers.length) return null;
    return <View style={card}><OfferBanner offers={p.offers} />{link('Sign in to apply', p.onSignIn)}</View>;
  }
  return <View style={card}>
    {applied ? <View style={{ gap: 4 }}>
      <Text role="status" style={{ ...body, ...bold }}>{`Offer applied: ${applied.name}`}</Text>
      <Text style={{ color: colors.primary, fontSize: 14, lineHeight: 20, ...bold }}>{`Saves ${formatINRFromPaise(p.pricing?.discount_paise ?? 0)}`}</Text>
      {applied.code ? <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ color: colors.muted, fontSize: 14 }}>{`Code ${applied.code}`}</Text>{link('Remove', p.onRemove, `Remove code ${applied.code}`)}
      </View> : null}
    </View> : null}
    {p.nudge ? <Text style={{ color: colors.primary, fontSize: 14, lineHeight: 20, ...bold }}>{nudgeText(p.nudge)}</Text> : null}
    {!open ? link('Have a code?', () => setOpen(true)) : <View style={{ gap: 8 }}>
      <MarketField label="Offer code" value={entry} autoCapitalize="characters" autoCorrect={false} maxLength={15} editable={!p.disabled && !p.applying} onChangeText={setEntry} onSubmitEditing={() => p.onApply(entry)} />
      <MarketButton label={p.applying ? 'Checking…' : 'Apply'} disabled={p.disabled || p.applying || !entry.trim()} onPress={() => p.onApply(entry)} />
    </View>}
    {p.message ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ color: colors.danger, fontSize: 15, lineHeight: 22 }}>{p.message}</Text> : null}
  </View>;
}
