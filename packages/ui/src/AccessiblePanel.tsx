import { useRef } from 'react';
import { AccessibilityInfo, findNodeHandle, Modal, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import type { ComponentRef, ReactNode } from 'react';
import { MarketCard } from './components';
import { useMarketFonts, useMarketTheme } from './theme';

// Capture the initiating control before opening so closing returns keyboard focus.
export function capturePanelFocus(): HTMLElement | null {
  return Platform.OS === 'web' && typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null;
}
export function restorePanelFocus(element: HTMLElement | null) {
  if (Platform.OS === 'web') setTimeout(() => { if (element?.isConnected) element.focus(); }, 0);
}
/**
 * A modal that moves focus to its heading when shown. `fullScreen` is the phone
 * editor layout: close button and title on top, scrolling body, pinned footer.
 * `sheet` is the phone confirmation layout: rises from the bottom with a grab handle.
 * Titles use the brand heading font when the owners' app has loaded it.
 */
export function AccessiblePanel({ title, children, onClose, fullScreen = false, sheet = false, footer, closeDisabled = false }: {
  title: string; children: ReactNode; onClose: () => void; fullScreen?: boolean; sheet?: boolean; footer?: ReactNode; closeDisabled?: boolean;
}) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  const titleFont = fonts.heading ? { fontFamily: fonts.heading } : { fontWeight: '700' as const };
  const heading = useRef<ComponentRef<typeof Text>>(null);
  const focusHeading = () => {
    const node = heading.current;
    if (Platform.OS === 'web') (node as unknown as HTMLElement | null)?.focus();
    else { const handle = findNodeHandle(node); if (handle != null) AccessibilityInfo.setAccessibilityFocus(handle); }
  };
  if (fullScreen) return <Modal visible animationType={Platform.OS === 'web' ? 'fade' : 'slide'} onRequestClose={onClose} onShow={focusHeading}>
    {/* Modals render outside the app's providers; measure insets here. */}
    <SafeAreaProvider><SafeAreaView accessibilityViewIsModal edges={['top', 'bottom', 'left', 'right']} style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close" accessibilityState={{ disabled: closeDisabled }} disabled={closeDisabled} onPress={onClose} style={({ pressed }) => ({ width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 24, opacity: closeDisabled ? 0.4 : pressed ? 0.6 : 1 })}>
          <Text accessible={false} aria-hidden style={{ fontSize: 22, lineHeight: 26, color: colors.ink }}>✕</Text>
        </Pressable>
        <Text ref={heading} accessibilityRole="header" {...({ tabIndex: -1 } as object)} style={{ flex: 1, fontSize: 22, lineHeight: 28, color: colors.ink, ...titleFont }}>{title}</Text>
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" style={{ flex: 1 }} contentContainerStyle={{ width: '100%', maxWidth: 600, alignSelf: 'center', padding: 16, gap: 18 }}>{children}</ScrollView>
      {footer ? <View style={{ width: '100%', maxWidth: 600, alignSelf: 'center', padding: 16, gap: 10, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.background }}>{footer}</View> : null}
    </SafeAreaView></SafeAreaProvider>
  </Modal>;
  if (sheet) return <Modal visible transparent animationType={Platform.OS === 'web' ? 'fade' : 'slide'} onRequestClose={onClose} onShow={focusHeading}>
    <SafeAreaProvider><View accessibilityViewIsModal style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
      <SafeAreaView edges={['bottom', 'left', 'right']} style={{ width: '100%', maxWidth: 600, maxHeight: '90%', alignSelf: 'center', backgroundColor: colors.background, borderTopLeftRadius: 24, borderTopRightRadius: 24 }}>
        {/* Bounded height: long content or large text scrolls instead of pushing the buttons off screen. */}
        <ScrollView keyboardShouldPersistTaps="handled" style={{ flexShrink: 1 }} contentContainerStyle={{ padding: 20, paddingTop: 10, gap: 14 }}>
          <View aria-hidden style={{ alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: 4 }} />
          <Text ref={heading} accessibilityRole="header" {...({ tabIndex: -1 } as object)} style={{ fontSize: 24, lineHeight: 30, color: colors.ink, ...titleFont }}>{title}</Text>
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
