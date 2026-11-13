import { useRef } from 'react';
import { AccessibilityInfo, findNodeHandle, Modal, Platform, ScrollView, Text, View } from 'react-native';
import type { ComponentRef, ReactNode } from 'react';
import { MarketCard } from './components';

// Capture the initiating control before opening so closing returns keyboard focus.
export function capturePanelFocus(): HTMLElement | null {
  return Platform.OS === 'web' && typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null;
}
export function restorePanelFocus(element: HTMLElement | null) {
  if (Platform.OS === 'web') setTimeout(() => { if (element?.isConnected) element.focus(); }, 0);
}
export function AccessiblePanel({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const heading = useRef<ComponentRef<typeof Text>>(null);
  const focusHeading = () => {
    const node = heading.current;
    if (Platform.OS === 'web') (node as unknown as HTMLElement | null)?.focus();
    else { const handle = findNodeHandle(node); if (handle != null) AccessibilityInfo.setAccessibilityFocus(handle); }
  };
  return <Modal visible transparent animationType="fade" onRequestClose={onClose} onShow={focusHeading}>
    <View accessibilityViewIsModal style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 20 }}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ width: '100%', maxWidth: 600, alignSelf: 'center' }}>
        <MarketCard><Text ref={heading} accessibilityRole="header" {...({ tabIndex: -1 } as object)} style={{ fontSize: 22, fontWeight: '700' }}>{title}</Text>{children}</MarketCard>
      </ScrollView>
    </View>
  </Modal>;
}
