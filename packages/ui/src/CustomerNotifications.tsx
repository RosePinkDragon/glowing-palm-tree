import { useEffect, useRef } from 'react';
import { AppState, Pressable, Text, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import type { useMarket } from './useMarket';
import { MarketButton, MarketStatus, MarketText } from './components';
import { MarketIcon, type MarketIconName } from './MarketIcons';
import { groupByDay, inboxTime } from './notification-inbox';
import { useMarketFonts, useMarketTheme } from './theme';

type Market = ReturnType<typeof useMarket>;
const statusIcon: Record<string, MarketIconName> = { placed: 'cash', accepted: 'bell', preparing: 'clock', out_for_delivery: 'map', delivered: 'check', cancelled: 'close' };
const fixedError = 'We could not load your notifications. Check your connection and try again.';

/** Notifications inbox (#55; customer p. 19): this restaurant's order updates from the last 30 days, newest first, by day. */
export function CustomerNotifications({ market, go }: { market: Market; go: (path: string) => void }) {
  const { colors, name } = useMarketTheme();
  const fonts = useMarketFonts();
  const { inbox, preferences } = market;
  const focused = useIsFocused();
  const userId = market.session?.user.id;
  const refresh = useRef(inbox.refresh); refresh.current = inbox.refresh;
  // The feed is not in Realtime: read it whenever the screen is shown and when the app returns to the foreground.
  useEffect(() => { if (focused && userId) void refresh.current(); }, [focused, userId, market.identityVersion]);
  useEffect(() => {
    if (!focused || !userId) return;
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') void refresh.current(); });
    return () => subscription.remove();
  }, [focused, userId]);
  const bold = fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const };
  const days = groupByDay(inbox.items);
  const blank = inbox.ready && !inbox.items.length;
  const open = (id: string, orderId: string) => { void inbox.markRead(id); go(`/orders/${orderId}`); };
  return <View style={{ gap: 16 }}>
    {preferences.ready ? <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, padding: 12, borderRadius: 12, backgroundColor: colors.tint }}>
      <Text style={{ flex: 1, minWidth: 200, color: colors.ink, fontSize: 14, lineHeight: 21 }}>
        <Text style={bold}>{preferences.prefs.push ? 'Order updates are on.' : 'Order updates are off.'}</Text>{preferences.prefs.push ? ' We only message you about your orders.' : ' You can still read them here.'}
      </Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Manage order updates" onPress={() => go('/account')} style={{ minHeight: 48, minWidth: 48, justifyContent: 'center', paddingHorizontal: 8 }}><Text style={{ color: colors.primary, fontSize: 15, ...bold }}>Manage</Text></Pressable>
    </View> : null}
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {inbox.unread ? <MarketButton label="Mark all read" variant="secondary" onPress={() => void inbox.markAllRead()} /> : null}
    </View>
    <View role="status" accessibilityLiveRegion="polite"><MarketText variant="muted">{inbox.ready ? (inbox.unread ? `${inbox.unread} unread` : 'All caught up') : ''}</MarketText></View>
    {inbox.actionError ? <Text accessibilityRole="alert" style={{ color: colors.danger, fontSize: 15 }}>We could not update your notifications. Please try again.</Text> : null}
    {inbox.loading && !inbox.ready ? <MarketStatus kind="loading" title="Loading your notifications" /> : null}
    {inbox.error && !inbox.ready ? <MarketStatus kind="error" title="Could not load notifications" message={fixedError} action={<MarketButton label="Retry notifications" onPress={() => void inbox.refresh()} />} /> : null}
    {inbox.error && inbox.ready ? <View style={{ gap: 8 }}><Text accessibilityRole="alert" style={{ color: colors.danger, fontSize: 15 }}>{fixedError}</Text><MarketButton label="Retry notifications" variant="secondary" onPress={() => void inbox.refresh()} /></View> : null}
    {blank && !inbox.error ? <MarketStatus kind="empty" title="No notifications yet" message={`Order updates from ${name} will appear here for 30 days.`} action={<MarketButton label="Browse the menu" onPress={() => go('/')} />} /> : null}
    {days.map(day => <View key={day.key} style={{ gap: 8 }}>
      <Text accessibilityRole="header" style={{ color: colors.muted, fontSize: 12, lineHeight: 18, letterSpacing: 1.5, textTransform: 'uppercase', ...bold }}>{day.label}</Text>
      <View role="group" accessibilityLabel={day.label} testID="notification-day" style={{ borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, overflow: 'hidden' }}>
        {day.items.map((item, index) => {
          const unread = !item.readAtISO;
          return <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`${unread ? 'Unread. ' : ''}${item.title}. ${item.body}. ${inboxTime(item.createdAtISO)}. Opens your order.`} onPress={() => open(item.id, item.orderId)}
            style={{ minHeight: 64, padding: 14, flexDirection: 'row', gap: 12, borderTopWidth: index ? 1 : 0, borderTopColor: colors.border, backgroundColor: unread ? colors.tint : colors.surface }}>
            <View accessible={false} testID="status-icon" style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: unread ? colors.surface : colors.tint }}><MarketIcon name={statusIcon[item.eventStatus] ?? 'bell'} color={colors.primary} size={18} /></View>
            <View style={{ flex: 1, gap: 4 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ flex: 1, color: colors.ink, fontSize: 16, lineHeight: 24, ...bold }}>{item.title}</Text>
                <Text style={{ color: colors.muted, fontSize: 13 }}>{inboxTime(item.createdAtISO)}</Text>
                {unread ? <View accessible={false} testID="unread-dot" style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: colors.primary }} /> : null}
              </View>
              <Text style={{ color: colors.ink, fontSize: 15, lineHeight: 22 }}>{item.body}</Text>
            </View>
          </Pressable>;
        })}
      </View>
    </View>)}
    {inbox.moreError ? <Text accessibilityRole="alert" style={{ color: colors.danger, fontSize: 15 }}>We could not load older notifications. Please try again.</Text> : null}
    {inbox.hasMore ? <MarketButton label={inbox.moreLoading ? 'Loading older notifications…' : inbox.moreError ? 'Retry older notifications' : 'Load more'} variant="secondary" disabled={inbox.moreLoading} onPress={() => void inbox.loadMore()} /> : null}
    {inbox.ready && inbox.items.length ? <Text style={{ color: colors.muted, fontSize: 13, textAlign: 'center' }}>Updates from the last 30 days are kept here.</Text> : null}
  </View>;
}
