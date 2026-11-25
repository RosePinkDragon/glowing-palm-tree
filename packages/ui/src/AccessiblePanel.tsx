import { useRef } from 'react';
import { AccessibilityInfo, findNodeHandle, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import type { ComponentRef, ReactNode } from 'react';
import { MarketCard } from './components';
import { MarketIcon } from './MarketIcons';
import { useMarketFonts, useMarketTheme } from './theme';

// Capture the initiating control before opening so closing returns keyboard focus.
export function capturePanelFocus(): HTMLElement | null {
  return Platform.OS === 'web' && typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null;
}
export function restorePanelFocus(element: HTMLElement | null) {
  if (Platform.OS === 'web') setTimeout(() => { if (element?.isConnected) element.focus(); }, 0);
}
/** Keeps the last word (the order number) whole: the text content is unchanged, only the wrapping rule. */
function NoBreakTail({ text }: { text: string }) {
  const cut = text.lastIndexOf(' ');
  if (cut < 0) return <>{text}</>;
  return <>{text.slice(0, cut + 1)}<Text style={Platform.OS === 'web' ? ({ whiteSpace: 'nowrap' } as object) : undefined}>{text.slice(cut + 1)}</Text></>;
}
/**
 * A modal that moves focus to its heading when shown. `fullScreen` is the phone
 * editor layout: close button and title on top, scrolling body, pinned footer.
 * `sheet` is the phone confirmation layout: rises from the bottom with a grab handle.
 * Titles use the brand heading font when the owners' app has loaded it.
 */
export function AccessiblePanel({ title, children, onClose, fullScreen = false, sheet = false, footer, closeDisabled = false, owner = false, subtitle, headerEnd, hero, titleLead, closeLabel = 'Close', initialFocusId }: {
  title: string; children: ReactNode; onClose: () => void; fullScreen?: boolean; sheet?: boolean; footer?: ReactNode; closeDisabled?: boolean;
  /** Dish details (#114): opt-in photo-led bottom sheet. `hero` is the edge-to-edge photo with a round close button in its top corner, the backdrop dismisses, and `footer` is pinned at the bottom. No hero keeps every other layout unchanged. */
  hero?: ReactNode; titleLead?: ReactNode; closeLabel?: string;
  /** Web: id of the control that takes focus when the panel opens instead of the heading (a confirmation puts it on its safe choice, #200). */
  initialFocusId?: string;
  /** Owners' order details and cancel sheet (#53): back arrow, `page` surface, subtitle and header-end slot, roomier sheet. Off keeps the editor and customer layouts unchanged. */
  owner?: boolean; subtitle?: string; headerEnd?: ReactNode;
}) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  const titleFont = fonts.heading ? { fontFamily: fonts.heading } : { fontWeight: '700' as const };
  const heading = useRef<ComponentRef<typeof Text>>(null);
  const focusHeading = () => {
    const node = heading.current;
    if (Platform.OS === 'web' && initialFocusId) {
      // The modal may report shown before its content is attached, and the focus trap may move focus first: retry briefly.
      let tries = 0;
      const attempt = () => { const target = document.getElementById(initialFocusId); if (target) target.focus(); if (document.activeElement !== target && tries++ < 5) setTimeout(attempt, 20); };
      attempt(); return;
    }
    if (Platform.OS === 'web') (node as unknown as HTMLElement | null)?.focus();
    else { const handle = findNodeHandle(node); if (handle != null) AccessibilityInfo.setAccessibilityFocus(handle); }
  };
  if (fullScreen) return <Modal visible animationType={Platform.OS === 'web' ? 'fade' : 'slide'} onRequestClose={onClose} onShow={focusHeading}>
    {/* Modals render outside the app's providers; measure insets here. */}
    <SafeAreaProvider><SafeAreaView accessibilityViewIsModal edges={['top', 'bottom', 'left', 'right']} style={{ flex: 1, backgroundColor: owner ? colors.page : colors.background }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.background }}>
        <Pressable accessibilityRole="button" accessibilityLabel={owner ? 'Back' : 'Close'} accessibilityState={{ disabled: closeDisabled }} disabled={closeDisabled} onPress={onClose} style={({ pressed }) => ({ width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 24, opacity: closeDisabled ? 0.4 : pressed ? 0.6 : 1 })}>
          {owner ? <MarketIcon name="back" color={colors.ink} size={24} /> : <Text accessible={false} aria-hidden style={{ fontSize: 22, lineHeight: 26, color: colors.ink }}>✕</Text>}
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text ref={heading} accessibilityRole="header" {...({ tabIndex: -1 } as object)} style={{ fontSize: 22, lineHeight: 28, color: colors.ink, ...titleFont }}>{title}</Text>
          {subtitle ? <Text style={{ fontSize: 13, lineHeight: 18, color: colors.muted, ...(fonts.body ? { fontFamily: fonts.body } : {}) }}>{subtitle}</Text> : null}
        </View>
        {headerEnd ? <View style={{ paddingRight: 8 }}>{headerEnd}</View> : null}
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" style={{ flex: 1 }} contentContainerStyle={{ width: '100%', maxWidth: 600, alignSelf: 'center', padding: 16, gap: owner ? 16 : 18 }}>{children}</ScrollView>
      {footer ? <View style={{ width: '100%', maxWidth: 600, alignSelf: 'center', padding: 16, gap: 10, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.background }}>{footer}</View> : null}
    </SafeAreaView></SafeAreaProvider>
  </Modal>;
  if (hero) return <Modal visible transparent animationType={Platform.OS === 'web' ? 'fade' : 'slide'} onRequestClose={onClose} onShow={focusHeading}>
    <SafeAreaProvider><View accessibilityViewIsModal style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
      <Pressable accessible={false} aria-hidden {...(Platform.OS === 'web' ? { tabIndex: -1 } as object : {})} disabled={closeDisabled} onPress={onClose} style={StyleSheet.absoluteFill} />
      <SafeAreaView nativeID="panel-sheet" edges={['bottom', 'left', 'right']} style={{ width: '100%', maxWidth: 600, maxHeight: '92%', alignSelf: 'center', backgroundColor: colors.background, borderTopLeftRadius: 24, borderTopRightRadius: 24, overflow: 'hidden' }}>
        <ScrollView keyboardShouldPersistTaps="handled" style={{ flexShrink: 1 }} contentContainerStyle={{ paddingBottom: 12 }}>
          {hero}
          <View style={{ paddingHorizontal: 16, paddingTop: 16, gap: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              {titleLead}
              <Text ref={heading} accessibilityRole="header" {...({ tabIndex: -1 } as object)} style={{ flexShrink: 1, fontSize: 28, lineHeight: 36, color: colors.ink, ...titleFont }}>{title}</Text>
            </View>
            {children}
          </View>
        </ScrollView>
        {footer ? <View style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 10, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.background }}>{footer}</View> : null}
        <Pressable accessibilityRole="button" accessibilityLabel={closeLabel} accessibilityState={{ disabled: closeDisabled }} disabled={closeDisabled} onPress={onClose}
          style={({ pressed }) => ({ position: 'absolute', top: 12, right: 12, width: 44, height: 44, borderRadius: 22, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center', opacity: closeDisabled ? 0.5 : pressed ? 0.8 : 1 })}>
          <Text accessible={false} aria-hidden style={{ fontSize: 20, lineHeight: 24, color: colors.ink }}>✕</Text>
        </Pressable>
      </SafeAreaView>
    </View></SafeAreaProvider>
  </Modal>;
  if (sheet) return <Modal visible transparent animationType={Platform.OS === 'web' ? 'fade' : 'slide'} onRequestClose={onClose} onShow={focusHeading}>
    <SafeAreaProvider><View accessibilityViewIsModal style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
      <SafeAreaView edges={['bottom', 'left', 'right']} style={{ width: '100%', maxWidth: 600, maxHeight: '90%', alignSelf: 'center', backgroundColor: colors.background, borderTopLeftRadius: 24, borderTopRightRadius: 24 }}>
        {/* Bounded height: long content or large text scrolls instead of pushing the buttons off screen. */}
        <ScrollView keyboardShouldPersistTaps="handled" style={{ flexShrink: 1 }} contentContainerStyle={{ padding: owner ? 24 : 20, paddingTop: 10, gap: owner ? 18 : 14 }}>
          <View aria-hidden style={{ alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: 4 }} />
          <Text ref={heading} accessibilityRole="header" {...({ tabIndex: -1 } as object)} style={{ fontSize: 24, lineHeight: 30, color: colors.ink, ...titleFont }}>{owner ? <NoBreakTail text={title} /> : title}</Text>
          {children}
        </ScrollView>
      </SafeAreaView>
    </View></SafeAreaProvider>
  </Modal>;
  return <Modal visible transparent animationType="fade" onRequestClose={onClose} onShow={focusHeading}>
    <View accessibilityViewIsModal style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 20 }}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ width: '100%', maxWidth: 600, alignSelf: 'center' }}>
        <MarketCard><Text ref={heading} accessibilityRole="header" {...({ tabIndex: -1 } as object)} style={{ fontSize: 22, ...titleFont }}>{title}</Text>{children}</MarketCard>
      </ScrollView>
    </View>
  </Modal>;
}
