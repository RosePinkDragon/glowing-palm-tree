import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import type { BusinessSlug } from '@market/core';
import type { Business } from '@market/services';
import { MarketButton } from './components';
import { MarketIcon } from './MarketIcons';
import { useMarketFonts, useMarketTheme } from './theme';

/** The closed notice copy (#58, customer p. 28): a bold lead and a plain follow-up, per brand voice. */
export const closedParts = (slug: BusinessSlug): { lead: string; rest: string } => slug === 'ammu-sammu'
  ? { lead: 'Not taking orders right now.', rest: 'You can still look at the menu. Check back a little later.' }
  : { lead: "The kitchen isn't taking orders right now.", rest: 'Browse the menu and check back a little later.' };
/** The full sentence, used wherever the notice is read as one line (ordering errors, dish details). */
export const closedMessage = (slug: BusinessSlug) => { const { lead, rest } = closedParts(slug); return `${lead} ${rest}`; };

/** Notice frame (customer p. 28): Ammu Sammu a dark rounded card with a clock, Kokani Dine Inn a gold band. Neutral states reuse the brand tint. */
function NoticeFrame({ closed, children }: { closed: boolean; children: ReactNode }) {
  const { colors, statusHeader } = useMarketTheme();
  const band = statusHeader === 'band';
  return <View style={{ gap: 12, paddingHorizontal: 18, paddingVertical: 16, borderRadius: band ? 14 : 20, backgroundColor: closed ? colors.notice : colors.tint, borderWidth: closed ? 0 : 1, borderColor: colors.border }}>{children}</View>;
}

function NoticeText({ closed, bold, children }: { closed: boolean; bold?: string; children?: ReactNode }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  const color = closed ? colors.onNotice : colors.ink;
  return <Text style={{ flex: 1, color, fontSize: 16, lineHeight: 24, ...(fonts.body ? { fontFamily: fonts.body } : {}) }}>
    {bold ? <Text style={{ ...(fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const }) }}>{bold}</Text> : null}{bold && children ? ' ' : null}{children}
  </Text>;
}

export function RestaurantNotice({ businessId, business, ready, error, retry, refused = false }: {
  businessId: BusinessSlug; business: Business | null; ready: boolean; error: string; retry: () => void; refused?: boolean;
}) {
  const { colors } = useMarketTheme();
  const clock = (closed: boolean) => <View aria-hidden style={{ marginTop: 3 }}><MarketIcon name="clock" color={closed ? colors.onNotice : colors.primary} size={22} /></View>;
  const refresh = <MarketButton label="Refresh restaurant status" variant="secondary" onPress={retry} />;
  if (refused || (ready && business && !business.acceptingOrders)) {
    const { lead, rest } = closedParts(businessId);
    return <NoticeFrame closed>
      <View role="status" accessibilityLiveRegion="polite" style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
        {clock(true)}
        <View style={{ flex: 1, gap: 6 }}>
          <NoticeText closed bold={lead}>{rest}</NoticeText>
          <Text style={{ color: colors.onNotice, fontSize: 14, lineHeight: 20 }}>Your saved cart is kept for later.</Text>
        </View>
      </View>
      {error ? refresh : null}
    </NoticeFrame>;
  }
  if (error) return <NoticeFrame closed={false}>
    <View role="status" accessibilityLiveRegion="polite" style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
      {clock(false)}
      <View style={{ flex: 1, gap: 6 }}>
        <NoticeText closed={false} bold="Could not confirm whether the restaurant is taking orders" />
        <Text style={{ color: colors.ink, fontSize: 15, lineHeight: 22 }}>{error}</Text>
        <Text style={{ color: colors.ink, fontSize: 15, lineHeight: 22 }}>You can browse the menu. Your saved cart is kept.</Text>
      </View>
    </View>
    {refresh}
  </NoticeFrame>;
  if (!ready) return <View role="status" accessibilityLiveRegion="polite"><Text style={{ color: colors.muted, fontSize: 15, lineHeight: 23 }}>Checking whether the restaurant is taking orders…</Text></View>;
  if (!business?.orderingEnabled) return <NoticeFrame closed={false}><View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>{clock(false)}<NoticeText closed={false}>Ordering is currently unavailable. You can still browse the menu.</NoticeText></View></NoticeFrame>;
  return null;
}
