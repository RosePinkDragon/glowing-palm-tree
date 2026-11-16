import { useEffect, useRef } from 'react';
import { Animated, Platform, Pressable, View } from 'react-native';
import { useMarketTheme } from './theme';

/**
 * The design's large pill switch, drawn the same on web and native (the platform
 * switch renders small on web). Colours come from the theme's semantic switch
 * tokens. Switch role with checked/disabled/busy state, a 48px target, pressed
 * feedback and a visible focus ring. While busy it stays focusable, is announced
 * as busy and ignores presses.
 */
export function MarketSwitch({ value, onValueChange, label, hint, disabled = false, busy = false }: {
  value: boolean; onValueChange: (next: boolean) => void; label: string; hint?: string; disabled?: boolean; busy?: boolean;
}) {
  const { colors } = useMarketTheme();
  const position = useRef(new Animated.Value(value ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(position, { toValue: value ? 1 : 0, duration: 150, useNativeDriver: Platform.OS !== 'web' }).start();
  }, [value, position]);
  const toggle = () => { if (!disabled && !busy) onValueChange(!value); };
  // Web keyboard: react-native-web already turns Enter into a press for every role,
  // but Space only for button-like roles, so Space is the one key handled here.
  const space = Platform.OS === 'web' ? { onKeyDown: (event: { key: string; preventDefault(): void }) => {
    if (event.key === ' ' || event.key === 'Spacebar') { event.preventDefault(); toggle(); }
  } } as object : {};
  return <Pressable
    accessibilityRole="switch" accessibilityLabel={label} accessibilityHint={hint}
    accessibilityState={{ checked: value, disabled, busy }} aria-checked={value} aria-busy={busy}
    disabled={disabled} onPress={toggle} {...space}
    style={state => ({
      minWidth: 52, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 20,
      opacity: disabled ? 0.55 : busy || state.pressed ? 0.8 : 1,
      ...((state as { focused?: boolean }).focused ? { outlineStyle: 'solid', outlineWidth: 2, outlineColor: colors.switchOn, outlineOffset: 2 } as object : {}),
    })}>
    <View style={{ width: 52, height: 30, borderRadius: 15, padding: 3, justifyContent: 'center', backgroundColor: value ? colors.switchOn : colors.switchOff }}>
      <Animated.View style={{
        width: 24, height: 24, borderRadius: 12, backgroundColor: colors.surface,
        shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 2, shadowOffset: { width: 0, height: 1 }, elevation: 2,
        transform: [{ translateX: position.interpolate({ inputRange: [0, 1], outputRange: [0, 22] }) }],
      }} />
    </View>
  </Pressable>;
}
