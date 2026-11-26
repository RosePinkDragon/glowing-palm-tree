import { useState } from 'react';
import { Linking, Platform, Text, View } from 'react-native';
import { MarketIcon, type MarketIconName } from './MarketIcons';
import { useFamilies } from './DishAction';
import { useMarketTheme } from './theme';
import { preferCall } from './support-model';

/** #202: "Prefer Call?" strip at the top of the customer menu. Real anchors on web (tel: / wa.me), Linking on native. Pure logic is in support-model. */
function Pill({ label, name, href, icon, filled, external }: { label: string; name: string; href: string; icon: MarketIconName; filled: boolean; external?: boolean }) {
  const { colors } = useMarketTheme();
  const f = useFamilies();
  const [failed, setFailed] = useState(false);
  const ink = filled ? colors.onPrimary : colors.primary;
  const web = Platform.OS === 'web';
  return <View style={{ gap: 4 }}>
    <Text accessibilityRole="link" accessibilityLabel={name}
      {...(web ? ({ href, ...(external ? { hrefAttrs: { target: '_blank', rel: 'noopener noreferrer' } } : {}) } as object) : { onPress: () => { setFailed(false); Linking.openURL(href).catch(() => setFailed(true)); } })}
      style={{ minHeight: 48, minWidth: 48, paddingHorizontal: 18, paddingVertical: 13, textAlign: 'center', borderRadius: 24, borderWidth: 1.5, borderColor: colors.primary, backgroundColor: filled ? colors.primary : colors.surface, overflow: 'hidden', color: ink, ...f.semi(15, 22) }}>
      <MarketIcon inline name={icon} color={ink} size={16} />{' '}{label}
    </Text>
    {failed ? <Text accessibilityRole="alert" style={{ color: colors.danger, fontSize: 13 }}>Could not open this link on this device.</Text> : null}
  </View>;
}
export function PreferCall({ business, demo }: { business: { contactPhone?: string | null; whatsappPhone?: string | null } | null; demo: boolean }) {
  const { colors, name, menuLayout } = useMarketTheme();
  const f = useFamilies();
  const offer = preferCall(business, name, demo);
  if (!offer) return null;
  return <View nativeID="prefer-call" style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: menuLayout === 'carta' ? 'center' : 'flex-start', columnGap: 10, rowGap: 6 }}>
    <Text style={{ color: colors.ink, ...f.semi(16, 24) }}>{offer.heading}</Text>
    <Pill {...offer.call} icon="phone" filled />
    {offer.whatsapp ? <Pill {...offer.whatsapp} icon="chat" filled={false} external /> : null}
  </View>;
}
