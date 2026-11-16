import { Platform } from 'react-native';
import Svg, { Path } from 'react-native-svg';

// Shared owner icons (#116): simple 24px outline glyphs, always decorative. The text beside
// them carries the meaning, so they are hidden from assistive technology.
const paths = {
  phone: 'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z',
  pin: 'M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z M12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  map: 'M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4z M8 2v16 M16 6v16',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9',
  offline: 'M1 1l22 22 M16.72 11.06A10.94 10.94 0 0 1 19 12.55 M5 12.55a10.94 10.94 0 0 1 5.17-2.39 M10.71 5.05A16 16 0 0 1 22.58 9 M1.42 9a15.91 15.91 0 0 1 4.7-2.88 M8.53 16.11a6 6 0 0 1 6.95 0 M12 20h.01',
} as const;

export type MarketIconName = keyof typeof paths;

/** Decorative line icon: always hidden from assistive tech, so the text beside it must carry the meaning. `nudge` drops it a few px to sit on the first text line; `inline` centres it on the text line when it sits inside a Text (web; native already centres inline views). */
export function MarketIcon({ name, color, size = 18, nudge = 0, inline = false }: { name: MarketIconName; color: string; size?: number; nudge?: number; inline?: boolean }) {
  const style = inline && Platform.OS === 'web' ? ({ verticalAlign: 'middle', marginTop: -2 } as object) : nudge ? { marginTop: nudge } : undefined;
  return <Svg aria-hidden accessible={false} importantForAccessibility="no" width={size} height={size} viewBox="0 0 24 24" style={style}>
    <Path d={paths[name]} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>;
}
