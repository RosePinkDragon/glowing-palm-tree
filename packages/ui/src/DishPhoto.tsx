import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { Image, Platform, Text, View, useWindowDimensions } from 'react-native';
import type { MenuItem } from '@market/core';
import { useMarketTheme } from './theme';

/** Only the two pre-sized, immutable assets from the upload pipeline are served. */
export function DishPhoto({ item, detail = false, viewportRevision = 0 }: { item: MenuItem; detail?: boolean; viewportRevision?: number }) {
  const { colors } = useMarketTheme();
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const container = useRef<ComponentRef<typeof View>>(null);
  const [visible, setVisible] = useState(Platform.OS === 'web' || detail);
  const [failed, setFailed] = useState<string | null>(null);
  const uri = detail ? item.imageUrl?.replace(/\/card\.webp$/, '/detail.webp') : item.imageUrl;
  const measure = () => {
    if (Platform.OS === 'web' || visible) return;
    container.current?.measureInWindow((_x, y, _width, height) => {
      if (height > 0 && y < windowHeight && y + height > 0) setVisible(true);
    });
  };
  // Native Image has no loading="lazy". Recheck its real screen position after
  // layout/scroll/rotation, and only mount it once it enters the viewport.
  useEffect(measure, [viewportRevision, windowHeight, windowWidth, visible]);
  const unavailable = !uri || failed === uri;
  return <View ref={container} onLayout={measure} style={{ height: detail ? 240 : 170, width: '100%', borderRadius: 14, overflow: 'hidden', backgroundColor: colors.tint }}>
    {unavailable ? <View accessible accessibilityRole="image" accessibilityLabel={`${item.name}: no photo available`} style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><Text accessible={false} aria-hidden style={{ color: colors.muted, fontSize: 15 }}>No photo available</Text></View>
      : Platform.OS === 'web' ? <img src={uri} alt={item.name} loading={detail ? 'eager' : 'lazy'} decoding="async" width={detail ? 960 : 320} height={detail ? 720 : 240} onError={() => setFailed(uri)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        : visible ? <Image accessibilityLabel={item.name} source={{ uri }} resizeMode="cover" onError={() => setFailed(uri)} style={{ width: '100%', height: '100%' }} /> : null}
  </View>;
}
