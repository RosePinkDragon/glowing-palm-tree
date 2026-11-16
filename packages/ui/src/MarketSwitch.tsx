import { useEffect, useRef } from 'react';
import { Animated, Platform, Pressable, View } from 'react-native';

// On/off colours from the owners' screens (p. 8–10): green on, warm grey off, white thumb.
export const SWITCH_ON = '#2E7D32';
export const SWITCH_OFF = '#857873';

/**
 * The design's large pill switch, drawn the same on web and native (the platform
 * switch renders small on web). Switch role with checked/disabled/busy state, a
 * 48px target, a visible focus ring, and Space/Enter toggling on web.
 */
export function MarketSwitch({ value, onValueChange, label, hint, disabled = false, busy = false }: {
  value: boolean; onValueChange: (next: boolean) => void; label: string; hint?: string; disabled?: boolean; busy?: boolean;
}) {
  const position = useRef(new Animated.Value(value ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(position, { toValue: value ? 1 : 0, duration: 150, useNativeDriver: Platform.OS !== 'web' }).start();
  }, [value, position]);
  const inactive = disabled || busy;
  const toggle = () => { if (!inactive) onValueChange(!value); };
  // Web keyboard: handled here (and not by the press handler) so one key press toggles once.
  const keyboard = Platform.OS === 'web' ? { onKeyDown: (event: { key: string; preventDefault(): void }) => {
    if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); toggle(); }
  } } as object : {};
  return <Pressable
    accessibilityRole="switch" accessibilityLabel={label} accessibilityHint={hint}
    accessibilityState={{ checked: value, disabled: inactive, busy }} aria-checked={value}
    disabled={inactive} onPress={toggle} {...keyboard}
    style={state => ({
      minWidth: 52, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 20,
      opacity: inactive ? 0.55 : 1,
      ...((state as { focused?: boolean }).focused ? { outlineStyle: 'solid', outlineWidth: 2, outlineColor: SWITCH_ON, outlineOffset: 2 } as object : {}),
    })}>
    <View style={{ width: 52, height: 30, borderRadius: 15, padding: 3, justifyContent: 'center', backgroundColor: value ? SWITCH_ON : SWITCH_OFF }}>
      <Animated.View style={{
        width: 24, height: 24, borderRadius: 12, backgroundColor: '#FFFFFF',
        shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 2, shadowOffset: { width: 0, height: 1 }, elevation: 2,
        transform: [{ translateX: position.interpolate({ inputRange: [0, 1], outputRange: [0, 22] }) }],
      }} />
    </View>
  </Pressable>;
}
